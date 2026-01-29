# v3计划最终验证清单

## 📋 修正完成状态

本文档记录所有文档一致性问题和实施层风险的修正状态。

---

## ✅ 一、文档层修正（已完成）

### 1.1 P2实施决策冲突 ✅

**问题**：
- `critical-patches-v3.md` 补丁3说"v3不实施P2"
- `implementation-plan-v3-corrected.md` Phase 3实施了P2

**修正状态**：✅ 已解决
- `critical-patches-v3.md` 补丁3部分标记为"已废弃"
- 明确指向 `implementation-plan-v3-corrected.md` Phase 3任务3.1作为权威实施方案

**验证方法**：
```bash
grep -n "已废弃" openspec/critical-patches-v3.md
# 应该找到第222行的废弃声明
```

---

### 1.2 PlaybackInfo subreqCount位置冲突 ✅

**问题**：
- `playbackinfo-cache-control-fix.md` 示例代码中subreqCount++在cache.put前
- `implementation-plan-v3-corrected.md` Phase 2任务2.1步骤4中subreqCount++在fetch前

**修正状态**：✅ 已解决
- `playbackinfo-cache-control-fix.md` 顶部添加醒目警告
- 明确指向Phase 2任务2.1步骤4作为完整实现参考
- 声明该文档仅讨论Cache-Control策略，不代表完整实现

**验证方法**：
```bash
head -20 openspec/playbackinfo-cache-control-fix.md
# 应该看到"⚠️ 重要声明"部分
```

---

## ✅ 二、实施层修正（已完成）

### 2.1 P2 timedOut语义不足 ✅

**问题**：
- 成功路径硬编码 `timedOut: false`
- 无法检测"超时后重试成功"场景
- X-Media-Timed-Out指标失真

**修正状态**：✅ 已解决
- 新增 `hadTimeout` 字段（跨attempt追踪）
- `timedOut` 仅表示本次attempt是否超时
- `hadTimeout` 表示是否发生过超时（即使重试成功）

**修正位置**：
- `implementation-plan-v3-corrected.md` Phase 3任务3.1步骤1（fetchWithTTFBWatchdog函数）
- 第454行：`let hadTimeout = false`
- 第505-507行：超时时设置 `hadTimeout = true`
- 第482-489行：返回值包含 `hadTimeout` 字段

**新增DEBUG头**：
```javascript
resHeaders.set('X-Media-Had-Timeout', p2Result.hadTimeout ? '1' : '0')
```

---

### 2.2 P2超时判定不稳定 ✅

**问题**：
- 依赖 `err.name === 'TTFBTimeoutError'`
- AbortController.abort(reason)的reason不一定以err.name暴露
- Workers运行时行为不确定

**修正状态**：✅ 已解决
- 使用本地旗标 `watchdogTimedOut`
- 在setTimeout回调中设置旗标
- catch块中使用旗标判定，不依赖err.name

**修正位置**：
- `implementation-plan-v3-corrected.md` Phase 3任务3.1步骤1
- 第459行：`let watchdogTimedOut = false`
- 第465-467行：setTimeout中设置旗标
- 第496行：`const isWatchdogTimeout = watchdogTimedOut`

**关键代码**：
```javascript
let watchdogTimedOut = false
const timeoutId = setTimeout(() => {
  watchdogTimedOut = true
  controller.abort()
}, currentTimeout)

// catch块中
const isWatchdogTimeout = watchdogTimedOut  // 使用本地旗标
```

---

### 2.3 P2网络错误检测脆弱 ✅

**问题**：
- 使用 `err.message.includes('fetch')`
- 依赖运行时文案，容易漏判/误判

**修正状态**：✅ 已解决
- 使用白名单：`err.name === 'TypeError'`
- 新增 `errorKind` 字段（timeout / network / other）
- 提供明确的错误分类用于排障

**修正位置**：
- `implementation-plan-v3-corrected.md` Phase 3任务3.1步骤1
- 第499行：`const isNetworkError = (err.name === 'TypeError')`
- 第502行：`const errorKind = isWatchdogTimeout ? 'timeout' : (isNetworkError ? 'network' : 'other')`

**新增DEBUG头**：
```javascript
resHeaders.set('X-Media-Error-Kind', p2Result.errorKind || 'none')
```

**应用逻辑错误处理**：
```javascript
if (meta.errorKind === 'timeout') {
  errorMsg = 'Gateway Timeout: Media TTFB exceeded'
  statusCode = 504
} else if (meta.errorKind === 'network') {
  errorMsg = 'Bad Gateway: Network error'
  statusCode = 502
} else {
  errorMsg = 'Bad Gateway: Unknown error'
  statusCode = 502
}
```

---

### 2.4 subreqCount统计一致性 ✅

**问题**：
- P2分支可能执行2次fetch（重试），但只做了一次subreqCount++
- Phase 4.2示例代码中subreqCount++位置错误

**修正状态**：✅ 已解决

**全局不变量（已在所有文档中统一）**：
1. subreqCount只统计upstream fetch次数
2. subreqCount++必须在fetch()调用前增加
3. cache.put不能计入subreqCount
4. P2重试场景使用 `subreqCount += p2Result.attempts`

**修正位置**：
- `implementation-plan-v3-corrected.md` Phase 3任务3.1步骤1
  - 第453行：`let totalAttempts = 0`
  - 第457行：`totalAttempts++`（每次尝试前增加）
  - 第488行：返回 `attempts: totalAttempts`

- `implementation-plan-v3-corrected.md` Phase 3任务3.1步骤2
  - 第573行：`subreqCount += p2Result.attempts`（使用attempts而非固定+1）
  - 第586行：异常时也使用 `subreqCount += meta.attempts`

- `implementation-plan-v3-corrected.md` Phase 2任务2.1步骤4
  - 第343行：`subreqCount++`在fetch前（正确位置）
  - 第357行：cache.put不增加subreqCount（正确）

- `playbackinfo-cache-control-fix.md`
  - 顶部添加全局不变量说明
  - 明确指向Phase 2任务2.1步骤4作为权威实现

---

## 📊 可观测性指标完整性

### P2 TTFB Watchdog DEBUG头（完整列表）

```javascript
if (p2Result && DEBUG) {
  resHeaders.set('X-Media-TTFB-Ms', p2Result.ttfbMs.toString())
  resHeaders.set('X-Media-Retry-Count', p2Result.retryCount.toString())
  resHeaders.set('X-Media-Timed-Out', p2Result.timedOut ? '1' : '0')
  resHeaders.set('X-Media-Had-Timeout', p2Result.hadTimeout ? '1' : '0')  // ✅ 新增
  resHeaders.set('X-Media-Attempts', p2Result.attempts.toString())
  resHeaders.set('X-Media-Error-Kind', p2Result.errorKind || 'none')  // ✅ 新增
}
```

**字段说明**：
- `X-Media-TTFB-Ms`：首字节到达时间（毫秒）
- `X-Media-Retry-Count`：重试次数（0或1）
- `X-Media-Timed-Out`：本次attempt是否超时（0或1）
- `X-Media-Had-Timeout`：🆕 是否发生过超时（包括之前的attempt，即使重试成功）
- `X-Media-Attempts`：总尝试次数（1或2）
- `X-Media-Error-Kind`：🆕 错误类型（timeout / network / other / none）

---

## 🔍 文档权威性声明

### 主实施计划（唯一权威）
**文件**：`implementation-plan-v3-corrected.md`

**权威章节**：
- Phase 2任务2.1步骤4：PlaybackInfo微缓存完整实现（包括正确的subreqCount位置）
- Phase 3任务3.1：P2 TTFB Watchdog完整实现（包括所有修正A-F）

### 补充文档（仅供参考）
**文件**：`playbackinfo-cache-control-fix.md`
- ⚠️ 仅讨论Cache-Control策略修改
- ⚠️ 代码片段不代表完整实现
- ✅ 必须参考主实施计划的Phase 2任务2.1步骤4

**文件**：`critical-patches-v3.md`
- ⚠️ 补丁3的P2部分已废弃
- ✅ 必须参考主实施计划的Phase 3任务3.1

---

## ✅ 最终验证命令

### 1. 验证扩展运算符语法
```bash
# 应该0命中（确保没有单点语法错误）
grep -n "{ \." openspec/implementation-plan-v3-corrected.md

# 应该找到所有正确的扩展运算符使用
grep -n "{ \.\.\." openspec/implementation-plan-v3-corrected.md
```

### 2. 验证P2实施决策一致性
```bash
# 应该找到"已废弃"声明
grep -n "已废弃" openspec/critical-patches-v3.md

# 应该找到Phase 3任务3.1
grep -n "Phase 3.*TTFB Watchdog" openspec/implementation-plan-v3-corrected.md
```

### 3. 验证subreqCount统计规范
```bash
# 应该找到所有正确的subreqCount++位置（在fetch前）
grep -B2 "subreqCount++" openspec/implementation-plan-v3-corrected.md

# 应该找到P2使用attempts的位置
grep -n "subreqCount += p2Result.attempts" openspec/implementation-plan-v3-corrected.md
grep -n "subreqCount += meta.attempts" openspec/implementation-plan-v3-corrected.md
```

### 4. 验证P2错误检测机制
```bash
# 应该找到本地旗标定义
grep -n "let watchdogTimedOut = false" openspec/implementation-plan-v3-corrected.md

# 应该找到hadTimeout字段
grep -n "let hadTimeout = false" openspec/implementation-plan-v3-corrected.md

# 应该找到errorKind字段
grep -n "errorKind" openspec/implementation-plan-v3-corrected.md
```

---

## 🎯 执行就绪确认

### 文档层 ✅
- [x] P2实施决策冲突已解决
- [x] PlaybackInfo subreqCount位置冲突已解决
- [x] 文档权威性已明确声明

### 实施层 ✅
- [x] P2 timedOut语义已增强（hadTimeout字段）
- [x] P2超时判定已稳定（本地旗标）
- [x] P2网络错误检测已加固（白名单+errorKind）
- [x] subreqCount统计已统一（attempts字段）

### 可观测性 ✅
- [x] 新增X-Media-Had-Timeout指标
- [x] 新增X-Media-Error-Kind指标
- [x] 所有DEBUG头已完整定义

---

## 📝 修正优先级回顾

| 优先级 | 问题 | 状态 | 修正位置 |
|--------|------|------|----------|
| **A** | P2 resHeaders未定义 | ✅ 已解决 | Phase 3任务3.1步骤2 |
| **B** | timedOut永远是false | ✅ 已解决 | Phase 3任务3.1步骤1（hadTimeout字段） |
| **C** | subreqCount统计不准 | ✅ 已解决 | Phase 3任务3.1步骤1+2（attempts字段） |
| **D** | P2最坏等待时间约9秒 | ✅ 已解决 | Phase 3任务3.1（二次3000ms） |
| **E** | Phase 4.2示例违反补丁4 | ✅ 已解决 | playbackinfo-cache-control-fix.md（警告） |
| **F** | preserveUpgrade参数说明不清 | ✅ 已解决 | Phase 2任务2.1步骤1（注释） |

---

## 🚀 下一步行动

**所有文档一致性问题和实施层风险已修正完成。**

**v3计划现在可以安全执行。**

**等待用户确认**：是否批准进入Phase 3执行阶段？

**Shall I proceed with Phase 3 execution? (Y/N)**
