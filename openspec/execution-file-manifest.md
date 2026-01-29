# Phase 3 执行阶段文件清单

## 📁 文件分类与优先级

---

## 🎯 一、核心执行文档（必读）

### 1. 主实施计划（唯一权威）⭐⭐⭐⭐⭐
**文件**：`openspec/implementation-plan-v3-corrected.md`

**用途**：Phase 3执行的唯一权威指南

**关键章节**：
- **Phase 1**（任务1.1-1.3）：低风险修复
  - 任务1.1：移除noTlsVerify无效字段
  - 任务1.2：统一MAX_BODY_BUFFER变量名
  - 任务1.3：调整API超时时间（4500ms）

- **Phase 2**（任务2.1-2.2）：RFC 7230合规性
  - 任务2.1：实现RFC 7230 Hop-by-hop清理（含4个补丁）
  - 任务2.2：保留Android TV请求侧Connection逻辑

- **Phase 3**（任务3.1）：媒体请求TTFB Watchdog（P2核心功能）
  - 步骤1：新增fetchWithTTFBWatchdog函数
  - 步骤2：应用于媒体请求处理

- **Phase 4**（任务4.1-4.3）：缓存策略优化
  - 任务4.1：m3u8使用private Cache-Control
  - 任务4.2：PlaybackInfo使用private Cache-Control
  - 任务4.3：Content-Length缺失时禁用PlaybackInfo微缓存

**执行顺序**：严格按Phase 1→2→3→4顺序执行

---

### 2. 最终验证清单 ⭐⭐⭐⭐
**文件**：`openspec/final-verification-checklist.md`

**用途**：确认所有修正已完成，执行前最后检查

**关键内容**：
- 文档层修正状态（P2冲突、subreqCount冲突）
- 实施层修正状态（timedOut、超时判定、网络错误检测）
- 优先级问题A-F解决状态
- 可观测性指标完整性
- 验证命令清单

**使用时机**：Phase 3执行前强制检查

---

## 📚 二、补充参考文档（重要）

### 3. 关键补丁文档 ⭐⭐⭐
**文件**：`openspec/critical-patches-v3.md`

**用途**：理解4个关键补丁的背景和理由

**关键补丁**：
- 补丁1：WebSocket Upgrade头保护（P0）
- 补丁2：proxy-*头保留策略（P1）
- 补丁3：API超时分流规则（P1）
- 补丁4：subreqCount统计位置（P2）

**注意**：补丁3的P2部分已废弃，以主实施计划为准

---

### 4. 执行补丁清单（A-F优先级）⭐⭐⭐
**文件**：`openspec/v3-execution-patches-A-F.md`

**用途**：理解6个执行前必须修正的问题

**优先级问题**：
- 优先级A：P2 resHeaders未定义问题
- 优先级B：timedOut永远是false
- 优先级C：subreqCount统计不准
- 优先级D：P2最坏等待时间约9秒
- 优先级E：Phase 4.2示例违反补丁4
- 优先级F：preserveUpgrade参数说明不清

**状态**：所有问题已在主实施计划中修正

---

### 5. PlaybackInfo Cache-Control修正 ⭐⭐
**文件**：`openspec/playbackinfo-cache-control-fix.md`

**用途**：理解PlaybackInfo Cache-Control策略变更理由

**关键内容**：
- 从`public`改为`private`的原因
- 与m3u8策略保持一致

**⚠️ 警告**：
- 本文档仅讨论Cache-Control策略
- 代码片段不代表完整实现
- 完整实现参考主实施计划Phase 2任务2.1步骤4

---

### 6. 语法修正清单 ⭐⭐
**文件**：`openspec/syntax-fix-checklist.md`

**用途**：防止扩展运算符语法错误

**关键约束**：
- 必须使用三个点：`...cfConfig`
- 禁止使用单点：`.cfConfig`（语法错误）

**验证方法**：
```bash
grep -n "{ \." openspec/implementation-plan-v3-corrected.md
# 应该0命中
```

---

## 🔧 三、参考实现代码

### 7. RFC 7230参考实现 ⭐⭐
**文件**：`openspec/cleanupHopByHopHeaders-correct.js`

**用途**：cleanupHopByHopHeaders函数的正确实现参考

**关键模式**：
1. 先读取Connection值
2. 再删除固定列表
3. 再删除动态字段

**注意**：主实施计划中的实现已包含所有补丁，此文件仅供理解

---

## 🎯 四、目标文件（待修改）

### 8. Worker代码 ⭐⭐⭐⭐⭐
**文件**：`worker.js`

**当前状态**：
```bash
git status
# M worker.js（有未提交的修改）
```

**执行策略**：
- 建议先提交或暂存当前修改
- 或者基于当前状态继续修改
- 执行完成后创建新的commit

---

## 📋 执行前检查清单

### 必读文档（按顺序）
1. ✅ `final-verification-checklist.md` - 确认所有修正已完成
2. ✅ `implementation-plan-v3-corrected.md` - 主实施计划（完整阅读）
3. ✅ `critical-patches-v3.md` - 理解4个关键补丁
4. ✅ `v3-execution-patches-A-F.md` - 理解6个优先级问题

### 可选参考文档
5. ⭕ `playbackinfo-cache-control-fix.md` - 理解Cache-Control策略
6. ⭕ `syntax-fix-checklist.md` - 防止语法错误
7. ⭕ `cleanupHopByHopHeaders-correct.js` - 参考实现

---

## 🚀 执行流程

### Step 1: 环境准备
```bash
cd D:\code\project\CF-Emby-Proxy
git status  # 检查当前状态
```

### Step 2: 文档确认
- 阅读 `final-verification-checklist.md`
- 确认所有修正已完成

### Step 3: 执行Phase 1-4
- 严格按照 `implementation-plan-v3-corrected.md` 执行
- 每个Phase完成后进行验证

### Step 4: 最终验证
- 执行 `final-verification-checklist.md` 中的验证命令
- 确认所有不变量检查通过

---

## ⚠️ 关键约束

### 文档权威性
- **唯一权威**：`implementation-plan-v3-corrected.md`
- **其他文档**：仅供理解背景和理由，不作为执行依据

### 执行顺序
- **强制顺序**：Phase 1 → Phase 2 → Phase 3 → Phase 4
- **禁止跳过**：任何Phase的跳过都需要用户明确批准

### 代码修改
- **目标文件**：仅修改 `worker.js`
- **修改范围**：严格按照主实施计划，不引入额外变更

---

## 📊 文件依赖关系

```
implementation-plan-v3-corrected.md (主实施计划)
    ├── 引用 critical-patches-v3.md (4个关键补丁)
    ├── 引用 v3-execution-patches-A-F.md (6个优先级问题)
    ├── 引用 playbackinfo-cache-control-fix.md (Cache-Control策略)
    └── 引用 syntax-fix-checklist.md (语法约束)

final-verification-checklist.md (最终验证)
    └── 验证以上所有文档的修正状态

cleanupHopByHopHeaders-correct.js (参考实现)
    └── 辅助理解RFC 7230实现

worker.js (目标文件)
    └── 根据主实施计划进行修改
```

---

## ✅ 执行就绪确认

**所有必需文件已准备完毕。**

**Phase 3执行可以开始。**
