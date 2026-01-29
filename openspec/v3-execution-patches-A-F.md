# v3计划执行前补丁清单（A-F优先级修正）

## 修正总览

本文档记录了v3计划执行前必须修正的6个关键问题（优先级从高到低：A→F）。

---

## 🚨 优先级A：P2 resHeaders未定义问题（结构性错误）

### 问题描述
P2分支中直接使用`resHeaders.set(...)`写入可观测性指标，但此时resHeaders还未创建。

### 修正方案
1. P2分支里只记录result到`p2Result`变量
2. 在统一构建`resHeaders = new Headers(response.headers)`之后再写入DEBUG头
3. 禁止在P2分支中直接操作resHeaders

### 修正位置
- `implementation-plan-v3-corrected.md` Phase 3任务3.1步骤2

### 验证方法
- 确认P2分支中没有直接操作resHeaders
- 确认DEBUG头在统一构建resHeaders后写入

---

## 🚨 优先级B：timedOut永远是false（指标失真）

### 问题描述
fetchWithTTFBWatchdog返回的timedOut硬编码为false，catch分支没有标记超时，无法区分"首包超时"和"真实网络错误"。

### 修正方案
1. 使用自定义错误`TTFBTimeoutError`标记watchdog超时
2. 在catch分支中判断是否是watchdog超时
3. timedOut必须真实反映本次attempt是否因watchdog超时被abort
4. 区分超时（504）和网络错误（502）

### 修正位置
- `implementation-plan-v3-corrected.md` Phase 3任务3.1步骤1（fetchWithTTFBWatchdog函数）
- `implementation-plan-v3-corrected.md` Phase 3任务3.1步骤2（应用逻辑）

### 验证方法
- 模拟TTFB超时，确认timedOut=true且返回504
- 模拟网络错误，确认timedOut=false且返回502

---

## 🚨 优先级C：subreqCount统计不准（P2下可能2次fetch）

### 问题描述
P2分支只做了一次subreqCount++，但可能执行2次fetch（重试1次），导致[PERF]指标不可信。

### 修正方案
1. fetchWithTTFBWatchdog返回`attempts = totalAttempts`（总尝试次数）
2. 调用方使用`subreqCount += p2Result.attempts`
3. 异常时也要从`err.ttfbWatchdogMeta.attempts`中提取并累加

### 修正位置
- `implementation-plan-v3-corrected.md` Phase 3任务3.1步骤1（fetchWithTTFBWatchdog函数）
- `implementation-plan-v3-corrected.md` Phase 3任务3.1步骤2（应用逻辑）

### 验证方法
- 模拟重试场景，确认subreqCount=2
- 检查[PERF]指标准确反映回源次数

---

## 🚨 优先级D：P2最坏等待时间约9秒（体感问题）

### 问题描述
4500ms × 2 + jitter ≈ 9秒，可能接近10秒，与"体感敏感"存在冲突。

### 修正方案
采用"二次更激进"策略：
- 第一次尝试：4500ms超时
- 第二次尝试：3000ms超时（更激进）
- 总计最坏等待时间：~7.5秒（4500 + jitter + 3000）

### 修正位置
- `implementation-plan-v3-corrected.md` Phase 3任务3.1 TTFB阈值部分
- `implementation-plan-v3-corrected.md` Phase 3任务3.1步骤1（fetchWithTTFBWatchdog函数）

### 验证方法
- 模拟两次超时，确认总耗时<8秒
- 确认第二次尝试使用3000ms超时

---

## 🚨 优先级E：Phase 4.2的PlaybackInfo示例违反补丁4

### 问题描述
Phase 4.2片段中subreqCount++放在cache.put前，与Phase 2的正确示例冲突，会导致指标打歪。

### 修正方案
1. 删除Phase 4.2片段中的subreqCount++
2. 添加说明："完整实现请参考Phase 2任务2.1步骤4"
3. 明确Phase 4.2仅关注Cache-Control策略修改

### 修正位置
- `implementation-plan-v3-corrected.md` Phase 4任务4.2

### 验证方法
- 确认Phase 4.2片段中没有subreqCount++
- 确认有明确说明指向Phase 2的完整示例

---

## 🚨 优先级F：preserveUpgrade参数说明不清

### 问题描述
当前调用策略下（WS请求侧不调用、101响应侧不调用），preserveUpgrade基本不会生效，容易误导实现者。

### 修正方案
在cleanupHopByHopHeaders函数参数说明中添加：
- 当前调用策略下，此参数基本不会生效
- 保留此参数仅用于将来可能出现的非标准场景
- 避免实现者误用

### 修正位置
- `implementation-plan-v3-corrected.md` Phase 2任务2.1步骤1（cleanupHopByHopHeaders函数参数说明）

### 验证方法
- 确认参数说明中包含"当前调用策略下基本不会生效"的说明
- 确认说明中包含"仅用于将来可能出现的非标准场景"

---

## 额外建议（非阻塞）

### 1. P2与客户端取消信号联动
建议补充执行约束：若运行环境支持`AbortSignal.any([clientSignal, controller.signal])`则合并；否则在客户端取消后尽早停止重试。

### 2. P2错误类型判断优化
建议改为：重试仅限`AbortError`（watchdog超时）或`TypeError`（网络失败）等明确集合，不要用`err.message.includes('fetch failed')`（过于脆弱）。

**修正状态**：已在优先级B中实现（使用`err.name === 'TypeError' && err.message.includes('fetch')`）

---

## 修正完成确认

- [x] 优先级A：resHeaders未定义问题
- [x] 优先级B：timedOut永远是false
- [x] 优先级C：subreqCount统计不准
- [x] 优先级D：P2最坏等待时间约9秒
- [x] 优先级E：Phase 4.2的PlaybackInfo示例违反补丁4
- [x] 优先级F：preserveUpgrade参数说明不清

所有6个优先级问题已修正完成，v3计划现在可以安全执行。
