# v3计划必须补丁清单

## 补丁1：WebSocket Upgrade头保护（最高优先级）

### 问题描述
当前cleanupHopByHopHeaders固定列表包含`upgrade`，并且在请求侧无条件调用：

```javascript
// RFC 7230: 清理 hop-by-hop 头 + Connection 声明的字段
cleanupHopByHopHeaders(proxyHeaders)

// 保留Android TV Connection逻辑（关键决策）
if (isAndroidTV && !isWebSocket) {
  proxyHeaders.set('Connection', 'keep-alive')
}
```

**致命后果**：
- WebSocket请求的`Upgrade: websocket`会被删除
- 上游收不到Upgrade头
- WebSocket握手失败（101状态码出不来）

### 修正方案

#### 方案A：条件调用（推荐）
```javascript
// RFC 7230: 清理 hop-by-hop 头（WebSocket除外）
if (!isWebSocket) {
  cleanupHopByHopHeaders(proxyHeaders)
}

// 保留Android TV Connection逻辑
if (isAndroidTV && !isWebSocket) {
  proxyHeaders.set('Connection', 'keep-alive')
}
```

#### 方案B：函数参数控制
```javascript
function cleanupHopByHopHeaders(headers, preserveUpgrade = false) {
  if (!headers) return

  // Step 1: 先读取并解析 Connection 头的值
  const connVal = headers.get('Connection') || headers.get('connection')
  const dynamicHopByHop = []
  if (connVal) {
    for (const token of connVal.split(',').map(t => t.trim()).filter(Boolean)) {
      dynamicHopByHop.push(token.toLowerCase())
    }
  }

  // Step 2: 删除固定 hop-by-hop 列表
  const fixed = [
    'connection',
    'keep-alive',
    'proxy-connection',
    'te',
    'trailer',
    'transfer-encoding',
    'proxy-authenticate',
    'proxy-authorization'
  ]

  // WebSocket时保留upgrade
  if (!preserveUpgrade) {
    fixed.push('upgrade')
  }

  for (const name of fixed) {
    headers.delete(name)
  }

  // Step 3: 删除 Connection 声明的动态字段
  for (const name of dynamicHopByHop) {
    // WebSocket时不删除upgrade
    if (preserveUpgrade && name === 'upgrade') continue
    headers.delete(name)
  }
}

// 使用时
cleanupHopByHopHeaders(proxyHeaders, isWebSocket)
```

### 响应侧同样需要保护

```javascript
// 在构建resHeaders后
const resHeaders = new Headers(response.headers)

// RFC 7230: 清理 hop-by-hop 头（101响应除外）
if (response.status !== 101) {
  cleanupHopByHopHeaders(resHeaders)
}

// 或者使用参数控制
cleanupHopByHopHeaders(resHeaders, response.status === 101)
```

### 硬约束
- **请求侧**：WebSocket请求（isWebSocket=true）时，**禁止**删除Upgrade和Connection头
- **响应侧**：101响应时，**禁止**删除Upgrade和Connection头
- **验证**：WebSocket连接必须返回101状态码，且包含Upgrade: websocket

---

## 补丁2：proxy-authorization/proxy-authenticate保留策略

### 问题描述
当前固定列表包含`proxy-authenticate`和`proxy-authorization`，会无条件删除。

**风险**：
- 某些上游或中间层可能使用这些头做鉴权
- 你无法控制源站行为
- "少删比多删更稳"

### 修正方案

#### 请求侧：不删除这两个头
```javascript
function cleanupHopByHopHeaders(headers, preserveUpgrade = false) {
  if (!headers) return

  // Step 1: 先读取并解析 Connection 头的值
  const connVal = headers.get('Connection') || headers.get('connection')
  const dynamicHopByHop = []
  if (connVal) {
    for (const token of connVal.split(',').map(t => t.trim()).filter(Boolean)) {
      dynamicHopByHop.push(token.toLowerCase())
    }
  }

  // Step 2: 删除固定 hop-by-hop 列表（移除proxy-*）
  const fixed = [
    'connection',
    'keep-alive',
    'proxy-connection',
    'te',
    'trailer',
    'transfer-encoding'
  ]

  if (!preserveUpgrade) {
    fixed.push('upgrade')
  }

  for (const name of fixed) {
    headers.delete(name)
  }

  // Step 3: 删除 Connection 声明的动态字段
  for (const name of dynamicHopByHop) {
    if (preserveUpgrade && name === 'upgrade') continue
    headers.delete(name)
  }
}
```

#### 响应侧：可以删除（一般不需要）
响应侧可以保持删除这两个头，因为客户端一般不需要。

### 硬约束
- **请求侧**：不删除`proxy-authenticate`和`proxy-authorization`
- **响应侧**：可以删除（可选）
- **理由**：上游可能依赖这些头，"少删比多删更稳"

---

## 补丁3：API超时分流规则明确化

### 问题描述
任务1.3写了`API_TIMEOUT: 4500`，但没有明确哪些路径使用超时，哪些路径无超时。

**风险**：
- 可能被误套到媒体/PlaybackInfo上
- 关键路径被错误限制超时

### 修正方案

#### 硬约束：超时分流规则

**使用API_TIMEOUT（4500ms）的路径**：
- 非媒体、非m3u8、非PlaybackInfo、非WebSocket的GET请求
- 例如：`/Users/xxx/Items/`、`/Items/Resume`等API

**禁止使用超时的路径**：
- 视频请求（isVideo=true）
- m3u8请求（isM3U8=true）
- PlaybackInfo POST请求
- WebSocket请求（isWebSocket=true）
- Range请求（hasRange=true）
- 所有POST请求（除非明确允许）

#### 实现示例

```javascript
// 确定是否使用超时
let useTimeout = false
let timeoutMs = 0

if (req.method === 'GET' && !isVideo && !isM3U8 && !isWebSocket && !hasRange) {
  // 非关键路径的GET请求使用超时
  useTimeout = true
  timeoutMs = isAndroidTV ? CONFIG.ANDROID_API_TIMEOUT : CONFIG.API_TIMEOUT
}

// 关键路径：无超时，直连
if (isVideo || isWebSocket || isM3U8 || hasRange || (isPlaybackInfo && req.method === 'POST')) {
  // 直连（无超时）
  const t0 = Date.now()
  subreqCount++
  response = await fetch(targetUrl.toString(), fetchOptions)
  upstreamMs += Date.now() - t0
} else if (useTimeout) {
  // 非关键路径：使用超时和重试
  response = await fetchWithTimeout(targetUrl.toString(), fetchOptions, timeoutMs, 2)
}
```

### ❌ P2 TTFB Watchdog说明（已废弃）

**⚠️ 此段落已废弃 - v3已决定实施P2 TTFB Watchdog**

**最新决策**：根据用户反馈，P2 TTFB Watchdog是解决"0kb/s卡死"的核心手段，**v3已决定实施**。

**完整实施方案请参考**：`implementation-plan-v3-corrected.md` Phase 3任务3.1

**实施范围**：
- 仅对媒体类GET/HEAD启用（isVideo或hasRange）
- TTFB阈值：4500ms（第一次）、3000ms（第二次重试）
- 最多重试1次
- 豁免：WebSocket、m3u8、POST、已取消请求

---

## 补丁4：subreqCount统计位置修正

### 问题描述
PlaybackInfo微缓存分支里，subreqCount++在cache.put前增加，会导致指标不准确。

```javascript
const toStore = new Response(upstreamResp.body, { status: upstreamResp.status, headers: resHeaders })
subreqCount++  // ❌ 错误位置
c.executionCtx.waitUntil(caches.default.put(cacheReq, toStore.clone()))
response = toStore
```

**问题**：
- subreqCount应该统计真正的upstream fetch次数
- cache.put不是subrequest
- 会导致[PERF]指标不可信

### 修正方案

#### 原则
- **subreqCount++**：只在真正的`fetch()`调用前增加
- **cache.put**：不增加subreqCount（或单独统计cache_put_count）

#### 修正后的PlaybackInfo微缓存逻辑

```javascript
const canPlaybackInfoCache = (isPlaybackInfo && req.method === 'POST' && !hasRange && canBufferBody)

if (canPlaybackInfoCache) {
  const bodyHash = await sha256Hex(reqBody || '')
  const tokenHash = await buildTokenKey(url)
  const cacheKey = `playbackinfo:${tokenHash}:${bodyHash}`
  const cacheReq = new Request(`https://cache.local/${cacheKey}`, { method: 'GET' })

  // 尝试从缓存读取
  let cached = await caches.default.match(cacheReq)
  if (cached) {
    response = cached
  } else {
    // 缓存未命中，回源
    const t0 = Date.now()
    subreqCount++  // ✅ 正确位置：在fetch前增加
    const upstreamResp = await fetch(targetUrl.toString(), fetchOptions)
    upstreamMs += Date.now() - t0

    const resHeaders = new Headers(upstreamResp.headers)
    cleanupHopByHopHeaders(resHeaders, upstreamResp.status === 101)

    if (upstreamResp.ok && (resHeaders.get('content-type') || '').includes('application/json')) {
      resHeaders.set('Cache-Control', `private, max-age=${CONFIG.PLAYBACKINFO_TTL}`)
      const toStore = new Response(upstreamResp.body, { status: upstreamResp.status, headers: resHeaders })

      // cache.put不增加subreqCount
      c.executionCtx.waitUntil(caches.default.put(cacheReq, toStore.clone()))
      response = toStore
    } else {
      response = upstreamResp
    }
  }
}
```

### 硬约束
- **subreqCount++**：只在`fetch()`调用前增加
- **cache.put**：不增加subreqCount
- **验证**：检查[PERF]指标，确保subreqCount准确反映回源次数

---

## 修正优先级

| 补丁 | 优先级 | 影响 | 修正难度 |
|------|--------|------|----------|
| 补丁1：WebSocket Upgrade保护 | **P0** | 致命 - WebSocket完全失效 | 低 |
| 补丁2：proxy-*头保留 | **P1** | 高 - 可能影响某些上游 | 低 |
| 补丁3：超时分流规则 | **P1** | 高 - 可能误杀关键路径 | 中 |
| 补丁4：subreqCount位置 | **P2** | 中 - 影响可观测性 | 低 |

---

## 验证清单

### 补丁1验证
- [ ] WebSocket请求保留Upgrade头
- [ ] WebSocket响应返回101状态码
- [ ] WebSocket连接正常建立

### 补丁2验证
- [ ] 请求侧不删除proxy-authenticate
- [ ] 请求侧不删除proxy-authorization
- [ ] 上游鉴权正常工作

### 补丁3验证
- [ ] 视频请求无超时限制
- [ ] m3u8请求无超时限制
- [ ] PlaybackInfo POST无超时限制
- [ ] 非关键API GET使用4500ms超时

### 补丁4验证
- [ ] subreqCount只统计fetch次数
- [ ] cache.put不增加subreqCount
- [ ] [PERF]指标准确反映回源次数
