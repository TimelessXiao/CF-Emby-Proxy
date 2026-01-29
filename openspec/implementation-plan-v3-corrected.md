# 最终实施计划 v3（完全修正版）

## 📋 执行概览

**项目**：CF-Emby-Proxy 性能优化与Bug修复（完全修正版 + 4个关键补丁）
**优先级**：P0（高优先级）
**关键修正**：
- ✅ cleanupHopByHopHeaders执行顺序修正（先读Connection再删除）
- ✅ 扩展运算符语法修正（`...cfConfig`而非`.cfConfig`）
- ✅ PlaybackInfo使用private Cache-Control（与m3u8保持一致）
- ✅ noTlsVerify改为无效字段清理
- ✅ 保留Android TV请求侧Connection: keep-alive

**关键补丁（P0级别）**：
- 🚨 **补丁1**：WebSocket Upgrade头保护（请求侧/响应侧条件调用cleanupHopByHopHeaders）
- 🚨 **补丁2**：proxy-authorization/proxy-authenticate保留（请求侧不删除）
- 🚨 **补丁3**：API超时分流规则明确化（明确哪些路径使用/不使用超时）
- 🚨 **补丁4**：subreqCount统计位置修正（只在fetch前增加）

**核心功能（P2级别）**：
- ⚡ **P2 TTFB Watchdog**：媒体请求首字节超时检测与重试（解决0kb/s卡死问题）
  - 范围：仅媒体类GET/HEAD（isVideo或hasRange）
  - 阈值：4500ms TTFB超时
  - 重试：最多1次，50-150ms jitter退避
  - 豁免：WebSocket、m3u8、POST、已取消请求

---

## 🎯 任务清单（按实施顺序）

### Phase 1: 低风险修复

#### 任务1.1：移除noTlsVerify无效字段（修正版）

**定性**：无效字段清理，不是TLS行为修复

**位置**：worker.js:158

**问题**：
- Cloudflare Workers的cf选项会静默忽略未知键
- 官方cf属性列表中不包含tlsVerifyOrigin或noTlsVerify
- 这是无效字段，不影响任何行为

**修复**：
```javascript
// BEFORE
const fetchOptions = {
  method: req.method,
  headers: proxyHeaders,
  body: reqBody,
  redirect: 'manual',
  cf: { ...cfConfig, noTlsVerify: true }  // ✅ 注意：三个点的扩展运算符
}

// AFTER
const fetchOptions = {
  method: req.method,
  headers: proxyHeaders,
  body: reqBody,
  redirect: 'manual',
  cf: { ...cfConfig }  // ✅ 注意：三个点的扩展运算符
}
```

**硬约束**：
- 必须使用三个点：`...cfConfig`
- 禁止使用单点：`.cfConfig`（这是语法错误）

**验证步骤**：
- [ ] grep检查noTlsVerify → 0命中
- [ ] 全文搜索 `{ .` → 应该0命中
- [ ] 全文搜索 `{ ...` → 应该找到所有正确的扩展运算符使用
- [ ] 确认请求行为无变化
- [ ] 确认无脚本异常

**风险**：极低 - 移除的是被忽略的字段

---

#### 任务1.2：统一MAX_BODY_BUFFER变量名

**位置**：worker.js:32, 78-82

**问题**：
- CONFIG中定义为MAX_BODY_BUFFER
- 使用时需要统一为CONFIG.MAX_BODY_BUFFER

**修复**：

**步骤1：CONFIG定义**
```javascript
const CONFIG = {
  // ... 其他配置

  // 最大允许缓冲请求体大小（字节）
  MAX_BODY_BUFFER: 262144, // 256KB

  // 路由表内存缓存 TTL（秒）
  ROUTE_CACHE_TTL: 60
}
```

**步骤2：使用时统一引用**
```javascript
// 在请求体缓冲逻辑中
const clHeader = req.headers.get('content-length')
const cl = clHeader ? parseInt(clHeader, 10) : NaN
const clValid = Number.isFinite(cl)
const canBufferBody = clValid && cl <= CONFIG.MAX_BODY_BUFFER
```

**硬约束**：
- 当Content-Length缺失或不可解析时，**必须**走"不缓冲、禁用微缓存、直连"路径
- 禁止AI自作主张去读流长度

**风险**：极低 - 只是变量名统一

---

#### 任务1.3：调整API超时时间

**位置**：worker.js:19

**修复**：
```javascript
// BEFORE
API_TIMEOUT: 2500,

// AFTER
API_TIMEOUT: 4500, // 按用户反馈，默认4500ms
```

**说明**：
- 非关键API GET使用4500ms超时
- Android TV API GET保持6000ms
- 关键路径（m3u8、PlaybackInfo、video）保持无超时

**🚨 补丁3：超时分流规则明确化**

**硬约束：使用API_TIMEOUT的路径**：
- 非媒体、非m3u8、非PlaybackInfo、非WebSocket的GET请求
- 例如：`/Users/xxx/Items/`、`/Items/Resume`等API

**硬约束：禁止使用超时的路径**：
- 视频请求（isVideo=true）
- m3u8请求（isM3U8=true）
- PlaybackInfo POST请求
- WebSocket请求（isWebSocket=true）
- Range请求（hasRange=true）
- 所有POST请求（除非明确允许）

**实现示例**：
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

**验证步骤**：
- [ ] 视频请求无超时限制
- [ ] m3u8请求无超时限制
- [ ] PlaybackInfo POST无超时限制
- [ ] 非关键API GET使用4500ms超时

**风险**：极低 - 增加容错性

---

### Phase 2: RFC 7230合规性

#### 任务2.1：实现RFC 7230 Hop-by-hop清理（修正版）

**位置**：worker.js:新增函数 + 应用位置

**目标**：完全符合RFC 7230规范的hop-by-hop头清理

**硬约束**：
- 删除固定hop-by-hop列表
- **动态删除Connection头value中列出的所有字段名**（大小写不敏感、需要trim）
- **关键修正**：必须先读取Connection值，再删除固定列表
- 🚨 **补丁1**：WebSocket时不删除upgrade和connection（preserveUpgrade参数）
- 🚨 **补丁2**：请求侧不删除proxy-authenticate和proxy-authorization

**实现**：

**步骤1：新增cleanupHopByHopHeaders函数（修正版 + 补丁1 + 补丁2）**
```javascript
// RFC 7230 hop-by-hop header cleanup (CORRECT ORDER + WebSocket Protection)
//
// 正确顺序（关键）：
// 1. 先读取 Connection 的值（如果存在）并解析 token
// 2. 再删除固定 hop-by-hop 列表
// 3. 再删除解析出来的 token 字段名
// 4. 最后删除 Connection 本身
//
// 参数：
// - headers: Headers对象
// - preserveUpgrade: 是否保留Upgrade头（WebSocket/101响应时为true）
//   🚨 修正F：当前调用策略下，此参数基本不会生效（WS请求侧不调用、101响应侧不调用）
//   保留此参数仅用于将来可能出现的非标准场景，避免实现者误用
// - isRequest: 是否为请求侧（请求侧不删除proxy-*头）
function cleanupHopByHopHeaders(headers, preserveUpgrade = false, isRequest = false) {
  if (!headers) return

  // Step 1: 先读取并解析 Connection 头的值（在删除之前！）
  const connVal = headers.get('Connection') || headers.get('connection')
  const dynamicHopByHop = []
  if (connVal) {
    // Parse comma-separated field-names; case-insensitive; trim whitespace
    for (const token of connVal.split(',').map(t => t.trim()).filter(Boolean)) {
      dynamicHopByHop.push(token.toLowerCase())
    }
  }

  // Step 2: 删除固定 hop-by-hop 列表
  const fixed = [
    'keep-alive',
    'proxy-connection',
    'te',
    'trailer',
    'transfer-encoding'
  ]

  // 补丁2：请求侧不删除proxy-*头（上游可能需要）
  if (!isRequest) {
    fixed.push('proxy-authenticate', 'proxy-authorization')
  }

  // 补丁1：WebSocket/101响应时不删除upgrade和connection
  if (!preserveUpgrade) {
    fixed.push('connection', 'upgrade')
  }

  for (const name of fixed) {
    headers.delete(name)
  }

  // Step 3: 删除 Connection 声明的动态字段
  for (const name of dynamicHopByHop) {
    // 补丁1：WebSocket时不删除upgrade
    if (preserveUpgrade && (name === 'upgrade' || name === 'connection')) continue
    headers.delete(name)
  }

  // Step 4: Connection 已在 Step 2 中删除（如果preserveUpgrade=false）
}
```

**步骤2：应用于请求侧（补丁1：WebSocket保护）**
```javascript
// 在构建proxyHeaders后，fetch前
const proxyHeaders = new Headers(req.headers)
proxyHeaders.set('Host', targetUrl.hostname)
proxyHeaders.set('Referer', targetUrl.origin)  // 保留
proxyHeaders.set('Origin', targetUrl.origin)    // 保留

// 剔除杂项头（保留原有逻辑）
proxyHeaders.delete('cf-connecting-ip')
proxyHeaders.delete('x-forwarded-for')
proxyHeaders.delete('cf-ray')
proxyHeaders.delete('cf-visitor')

// 🚨 补丁1：RFC 7230清理（WebSocket除外）
// WebSocket请求必须保留Upgrade和Connection头，否则握手失败
if (!isWebSocket) {
  cleanupHopByHopHeaders(proxyHeaders, false, true)  // preserveUpgrade=false, isRequest=true
}

// 保留Android TV Connection逻辑（关键决策）
if (isAndroidTV && !isWebSocket) {
  proxyHeaders.set('Connection', 'keep-alive')
}
```

**硬约束**：
- WebSocket请求（isWebSocket=true）时，**禁止**调用cleanupHopByHopHeaders
- 必须保留Upgrade和Connection头，否则WebSocket握手失败
- Android TV逻辑在清理之后执行，因此Connection: keep-alive会被保留

**步骤3：应用于响应侧（补丁1：101响应保护）**
```javascript
// 在构建resHeaders后
const resHeaders = new Headers(response.headers)

// 🚨 补丁1：RFC 7230清理（101响应除外）
// 101 Switching Protocols响应必须保留Upgrade和Connection头
if (response.status !== 101) {
  cleanupHopByHopHeaders(resHeaders, false, false)  // preserveUpgrade=false, isRequest=false
}

resHeaders.delete('content-security-policy')
resHeaders.delete('clear-site-data')
resHeaders.set('access-control-allow-origin', '*')

// Connection optimization: Android TV uses keep-alive
if (isVideo && isAndroidTV) {
  resHeaders.set('Connection', 'keep-alive')
  resHeaders.set('Keep-Alive', 'timeout=30, max=1000')
}
```

**硬约束**：
- 101响应（WebSocket握手成功）时，**禁止**调用cleanupHopByHopHeaders
- 必须保留Upgrade和Connection头，否则WebSocket连接失败
- 响应侧可以删除proxy-authenticate和proxy-authorization（isRequest=false）

**步骤4：PlaybackInfo缓存前也清理（补丁1 + 补丁4）**
```javascript
// 在PlaybackInfo POST微缓存分支中
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
    subreqCount++  // 🚨 补丁4：正确位置 - 在fetch前增加
    const upstreamResp = await fetch(targetUrl.toString(), fetchOptions)
    upstreamMs += Date.now() - t0

    const resHeaders = new Headers(upstreamResp.headers)

    // 🚨 补丁1：清理hop-by-hop头（PlaybackInfo不会是101响应）
    cleanupHopByHopHeaders(resHeaders, false, false)

    if (upstreamResp.ok && (resHeaders.get('content-type') || '').includes('application/json')) {
      resHeaders.set('Cache-Control', `private, max-age=${CONFIG.PLAYBACKINFO_TTL}`)  // ✅ 使用private
      const toStore = new Response(upstreamResp.body, { status: upstreamResp.status, headers: resHeaders })

      // cache.put不增加subreqCount（补丁4）
      c.executionCtx.waitUntil(caches.default.put(cacheReq, toStore.clone()))
      response = toStore
    } else {
      response = upstreamResp
    }
  }
}
```

**硬约束**：
- subreqCount++只在fetch()调用前增加（补丁4）
- cache.put不增加subreqCount（补丁4）
- 使用cleanupHopByHopHeaders(resHeaders, false, false)清理响应头（补丁1）

**验证步骤**：
- [ ] 测试`Connection: foo, bar`动态删除foo和bar
- [ ] 确认上游不收到hop-by-hop头
- [ ] 确认客户端不收到上游的hop-by-hop头
- [ ] 确认Android TV响应仍有Connection: keep-alive
- [ ] 确认WebSocket连接正常（101状态码）

**风险**：中 - 可能影响某些特殊客户端

---

#### 任务2.2：保留Android TV请求侧Connection逻辑（关键决策）

**决策**：**保留**现有逻辑，不删除

**位置**：worker.js:请求处理部分

**保留的代码**：
```javascript
// Android TV：设置 keep-alive (skip for WebSocket to preserve Upgrade header)
if (isAndroidTV && !isWebSocket) {
  proxyHeaders.set('Connection', 'keep-alive')
}
```

**理由**：
1. Android TV/ExoPlayer实现不一致
2. 某些客户端可能不能优雅处理缺少此头
3. 可能导致每个媒体分片都建立新TCP连接
4. 破坏播放风险 >> 移除标准头收益
5. 用户明确提到"风险较高"

**注意**：
- 此逻辑在cleanupHopByHopHeaders之后执行
- 因此Connection: keep-alive会被保留并发送给上游

**风险**：低 - 保持现状，不引入变更

---

### Phase 3: 媒体请求TTFB Watchdog（P2核心功能）

#### 任务3.1：实现媒体请求首字节超时检测与重试

**目标**：解决"长时间0.00kb/s卡死"问题，Worker侧主动防御

**位置**：worker.js:媒体请求处理部分

**实施范围（硬约束）**：
- ✅ **启用条件**：`(isVideo === true || hasRange === true) && ['GET', 'HEAD'].includes(req.method)`
- ❌ **豁免条件**：
  - `isWebSocket === true`（WebSocket不适用）
  - `isM3U8 === true`（m3u8走P4的微缓存修复）
  - `req.method === 'POST'`（POST不启用，尤其不对PlaybackInfo）
  - `request.signal?.aborted === true`（客户端已取消）

**TTFB阈值**：
- **4500ms**（与CONFIG.API_TIMEOUT一致）
- **定义**：在4500ms内fetch没有resolve出Response（拿不到响应头）
- **清理时机**：一旦拿到Response headers，立即清掉计时器，后续body streaming不干预
- 🚨 **修正D：二次重试更激进**
  - 第一次尝试：4500ms超时
  - 第二次尝试：3000ms超时（更激进）
  - 总计最坏等待时间：~7.5秒（4500 + jitter + 3000）
  - 避免体感接近10秒的问题

**重试策略（硬约束）**：
- **最大重试次数**：1次（总共最多2次请求）
- **触发条件**：仅当fetch抛异常（TTFB timeout / NetworkError / Abort due to watchdog）
- **不重试条件**：拿到任何Response（包括4xx/5xx）都不重试，原样返回
- **退避策略**：重试前等待50-150ms jitter（避免同时重试雪崩）
- **禁止行为**：不"换路由/换PoP"（Worker无法控制colo）

**实现方案**：

**步骤1：新增fetchWithTTFBWatchdog函数（修正B+C+D+问题3+4+5）**
```javascript
// 媒体请求TTFB Watchdog：检测首字节超时并重试
async function fetchWithTTFBWatchdog(url, options, ttfbTimeout, maxRetries = 1) {
  let retryCount = 0
  let lastError = null
  let ttfbMs = 0
  let totalAttempts = 0  // 🚨 修正C：记录总尝试次数
  let hadTimeout = false  // 🚨 问题3：记录是否发生过超时（即使重试成功）

  while (retryCount <= maxRetries) {
    totalAttempts++
    const controller = new AbortController()
    let watchdogTimedOut = false  // 🚨 问题4：本地旗标，稳定判定超时

    // 🚨 修正D：第二次尝试使用更激进的超时（3000ms）
    const currentTimeout = (retryCount === 0) ? ttfbTimeout : 3000

    // 🚨 问题4：使用本地旗标标记超时，不依赖err.name
    const timeoutId = setTimeout(() => {
      watchdogTimedOut = true
      controller.abort()  // 不需要传reason，用旗标判定
    }, currentTimeout)

    try {
      const t0 = Date.now()
      const response = await fetch(url, {
        ...options,
        signal: controller.signal
      })
      ttfbMs = Date.now() - t0

      // 成功拿到Response headers，清除超时计时器
      clearTimeout(timeoutId)

      // 🚨 问题3：返回hadTimeout，记录是否发生过超时
      return {
        response,
        ttfbMs,
        retryCount,
        timedOut: false,  // 本次成功，未超时
        hadTimeout,  // 🚨 问题3：是否发生过超时（包括之前的attempt）
        attempts: totalAttempts,
        errorKind: null  // 🚨 问题5：成功时无错误
      }
    } catch (err) {
      clearTimeout(timeoutId)
      lastError = err

      // 🚨 问题4：使用本地旗标判定超时，稳定可靠
      const isWatchdogTimeout = watchdogTimedOut

      // 🚨 问题5：使用白名单判断网络错误，不依赖message
      const isNetworkError = (err.name === 'TypeError')

      // 🚨 问题5：记录错误类型用于排障
      const errorKind = isWatchdogTimeout ? 'timeout' : (isNetworkError ? 'network' : 'other')

      // 记录是否发生过超时
      if (isWatchdogTimeout) {
        hadTimeout = true
      }

      // 检查是否应该重试（仅限超时或网络错误）
      if (retryCount < maxRetries && (isWatchdogTimeout || isNetworkError)) {
        retryCount++
        // 退避：50-150ms jitter
        const jitter = 50 + Math.random() * 100
        await new Promise(resolve => setTimeout(resolve, jitter))
        continue
      }

      // 不重试，抛出异常（附加元数据）
      lastError.ttfbWatchdogMeta = {
        timedOut: isWatchdogTimeout,
        hadTimeout,  // 🚨 问题3
        retryCount,
        attempts: totalAttempts,
        errorKind  // 🚨 问题5：timeout / network / other
      }
      throw lastError
    }
  }
}
```

**硬约束（问题3+4+5修正）**：
- 🚨 **问题4**：使用本地旗标`watchdogTimedOut`判定超时，不依赖`err.name`或`err.cause`
- 🚨 **问题3**：返回`hadTimeout`字段，记录是否发生过超时（即使重试成功）
- 🚨 **问题5**：使用白名单判断网络错误（`err.name === 'TypeError'`），不依赖`message.includes`
- 🚨 **问题5**：返回`errorKind`字段（timeout / network / other）用于排障

**硬约束（修正B）**：
- 使用自定义错误`TTFBTimeoutError`标记watchdog超时
- `timedOut`必须真实反映：本次是否因watchdog超时被abort
- 区分"watchdog超时"和"真实网络错误"（TypeError）
- 抛出异常时附加`ttfbWatchdogMeta`元数据

**硬约束（修正C）**：
- 返回`attempts = totalAttempts`（总尝试次数）
- 调用方必须使用`subreqCount += p2Result.attempts`

**步骤2：应用于媒体请求处理（修正A+C）**
```javascript
// 媒体请求处理分支
let p2Result = null  // 保存P2 TTFB Watchdog结果，稍后写入DEBUG头

const shouldUseTTFBWatchdog = (
  (isVideo || hasRange) &&
  ['GET', 'HEAD'].includes(req.method) &&
  !isWebSocket &&
  !isM3U8 &&
  !request.signal?.aborted
)

if (shouldUseTTFBWatchdog) {
  // 使用TTFB Watchdog
  const t0 = Date.now()

  try {
    p2Result = await fetchWithTTFBWatchdog(
      targetUrl.toString(),
      fetchOptions,
      CONFIG.API_TIMEOUT  // 4500ms
    )

    // 🚨 修正C：使用attempts统计总尝试次数
    subreqCount += p2Result.attempts

    response = p2Result.response
    upstreamMs += Date.now() - t0
  } catch (err) {
    // 🚨 修正B+C+问题3+5：从异常元数据中提取信息
    const meta = err.ttfbWatchdogMeta || {
      timedOut: false,
      hadTimeout: false,  // 🚨 问题3
      retryCount: 0,
      attempts: 1,
      errorKind: 'other'  // 🚨 问题5
    }
    subreqCount += meta.attempts

    // 🚨 问题5：使用errorKind区分错误类型
    let errorMsg, statusCode
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

    return new Response(errorMsg, {
      status: statusCode,
      headers: { 'Content-Type': 'text/plain' }
    })
  }
} else if (isVideo || isWebSocket || hasRange) {
  // 其他媒体请求：直连（无超时）
  const t0 = Date.now()
  subreqCount++
  response = await fetch(targetUrl.toString(), fetchOptions)
  upstreamMs += Date.now() - t0
}

// ... 后续统一构建resHeaders的地方 ...
const resHeaders = new Headers(response.headers)

// 🚨 修正A：在统一构建resHeaders后写入P2可观测性指标
if (p2Result && DEBUG) {
  resHeaders.set('X-Media-TTFB-Ms', p2Result.ttfbMs.toString())
  resHeaders.set('X-Media-Retry-Count', p2Result.retryCount.toString())
  resHeaders.set('X-Media-Timed-Out', p2Result.timedOut ? '1' : '0')
  resHeaders.set('X-Media-Had-Timeout', p2Result.hadTimeout ? '1' : '0')  // 🚨 问题3：是否发生过超时
  resHeaders.set('X-Media-Attempts', p2Result.attempts.toString())  // 🚨 修正C
  resHeaders.set('X-Media-Error-Kind', p2Result.errorKind || 'none')  // 🚨 问题5：错误类型
}
```

**硬约束（修正A）**：
- P2分支里只记录result到`p2Result`变量
- 在统一构建`resHeaders = new Headers(response.headers)`之后再写入DEBUG头
- 禁止在P2分支中直接操作`resHeaders`（此时还未创建）

**可观测性指标（DEBUG模式）**：
- `X-Media-TTFB-Ms`：首字节到达时间（毫秒）
- `X-Media-Retry-Count`：重试次数（0或1）
- `X-Media-Timed-Out`：本次是否超时（0或1）
- `X-Media-Had-Timeout`：🚨 **问题3** - 是否发生过超时（包括之前的attempt，即使重试成功）
- `X-Media-Attempts`：总尝试次数（1或2）
- `X-Media-Error-Kind`：🚨 **问题5** - 错误类型（timeout / network / other / none）
- `X-Media-Timed-Out`：是否发生TTFB超时（0或1）
- 现有指标：`cf.colo`、`clientTcpRtt`、`ip_version`（通过cf对象获取）

**验证步骤**：
- [ ] 媒体请求（isVideo=true）启用TTFB Watchdog
- [ ] Range请求（hasRange=true）启用TTFB Watchdog
- [ ] m3u8请求不启用TTFB Watchdog
- [ ] WebSocket请求不启用TTFB Watchdog
- [ ] POST请求不启用TTFB Watchdog
- [ ] TTFB超时后自动重试1次
- [ ] 拿到4xx/5xx响应不重试
- [ ] DEBUG模式下可观测性指标正确

**风险**：中 - 增加了重试逻辑，可能增加延迟，但解决了0kb/s卡死问题

---

### Phase 4: 缓存策略优化

#### 任务4.1：m3u8使用private Cache-Control

**位置**：worker.js:响应处理部分

**问题**：
- 之前计划使用`public, max-age=2`
- `public`可能导致客户端侧/中间缓存产生不可控复用
- 尤其是非标准客户端栈

**修复**：
```javascript
// m3u8 Cache-Control Strategy: Use `private` to prevent client-side/intermediate cache issues.
// The edge cache is correctly handled by cfConfig.cacheKey and cfConfig.cacheTtl.
if (isM3U8 && response.ok) {
  resHeaders.set('Cache-Control', `private, max-age=${CONFIG.M3U8_TTL}`);
}
```

**说明**：
- 边缘缓存：仍然通过`caches.default` + token-aware key控制
- 客户端Cache-Control：使用`private`避免共享缓存

**验证步骤**：
- [ ] m3u8响应包含`Cache-Control: private, max-age=2`
- [ ] 边缘微缓存仍然生效（检查cache_hit）
- [ ] 客户端不会产生不可控复用

**风险**：低 - 降低中间缓存风险

---

#### 任务4.2：PlaybackInfo使用private Cache-Control（修正版）

**位置**：worker.js:PlaybackInfo POST微缓存分支

**问题**：
- m3u8已改为`private, max-age=2`
- 但PlaybackInfo仍使用`public, max-age=3`
- 这与"避免不可控复用"的原则冲突

**修复**：
```javascript
// 🚨 修正E：此处仅展示Cache-Control修改，完整实现请参考Phase 2任务2.1步骤4
// 在PlaybackInfo POST微缓存分支中
const resHeaders = new Headers(upstreamResp.headers)
cleanupHopByHopHeaders(resHeaders, false, false)  // 清理hop-by-hop头
if (upstreamResp.ok && (resHeaders.get('content-type') || '').includes('application/json')) {
  resHeaders.set('Cache-Control', `private, max-age=${CONFIG.PLAYBACKINFO_TTL}`)  // ✅ 修正：使用private
  const toStore = new Response(upstreamResp.body, { status: upstreamResp.status, headers: resHeaders })
  // 注意：subreqCount++应在fetch前增加，不在cache.put前增加（参考Phase 2任务2.1步骤4）
  c.executionCtx.waitUntil(caches.default.put(cacheReq, toStore.clone()))
  response = toStore
}
```

**🚨 重要说明（修正E）**：
- 本任务仅关注Cache-Control策略修改（从public改为private）
- **完整的PlaybackInfo微缓存实现请参考Phase 2任务2.1步骤4**
- Phase 2的示例包含正确的subreqCount统计位置（fetch前增加，cache.put不增加）

**硬约束（用户态数据的Cache-Control策略）**：
1. **m3u8**：`private, max-age=2`
2. **PlaybackInfo**：`private, max-age=3`
3. **其他API微缓存**：如果未来添加，也必须使用`private`

**禁止**：
- 对token/body相关的用户态数据使用`public`
- 对需要token-aware缓存的内容使用`public`

**允许**：
- 静态资源（图片、CSS、JS）可以使用`public`
- 完全公开的、无用户态的内容可以使用`public`

**验证步骤**：
- [ ] PlaybackInfo响应包含`Cache-Control: private, max-age=3`
- [ ] 边缘微缓存仍然生效（检查cache_hit）
- [ ] 与m3u8策略保持一致

**风险**：低 - 降低中间缓存风险

---

#### 任务4.3：Content-Length缺失时禁用PlaybackInfo微缓存

**位置**：worker.js:78-82, 179-211

**目标**：避免大body或未知长度body的盲目缓冲

**修复**：

**步骤1：请求体缓冲策略**
```javascript
// 默认不缓冲请求体
let reqBody = req.body
let canBufferBody = false

if (!['GET', 'HEAD'].includes(req.method) && !url.pathname.includes('/Upload')) {
  const clHeader = req.headers.get('content-length')
  const cl = clHeader ? parseInt(clHeader, 10) : NaN
  const clValid = Number.isFinite(cl)
  canBufferBody = clValid && cl <= CONFIG.MAX_BODY_BUFFER

  if (canBufferBody) {
    reqBody = await req.arrayBuffer()
    // Let runtime recalc Content-Length for the buffered body
    proxyHeaders.delete('content-length')
  } else {
    // 不缓冲：保持流式；无/无效 Content-Length 时后续禁用微缓存并直连
    reqBody = req.body
  }
}
```

**步骤2：PlaybackInfo POST条件微缓存**
```javascript
// PlaybackInfo POST 微缓存（仅当可安全缓冲时）
const canPlaybackInfoCache = (isPlaybackInfo && req.method === 'POST' && !hasRange && canBufferBody)

if (canPlaybackInfoCache) {
  const bodyHash = await sha256Hex(reqBody || '')
  // ... 微缓存逻辑
} else if (
  isVideo ||
  isWebSocket ||
  (req.method === 'POST' && !(isPlaybackInfo && !hasRange)) ||
  // 当 PlaybackInfo POST 无法缓冲：禁用微缓存并直连
  (isPlaybackInfo && req.method === 'POST' && !hasRange && !canBufferBody)
) {
  // 直连 (无超时，无重试)
  const t0 = Date.now()
  subreqCount++
  response = await fetch(targetUrl.toString(), fetchOptions)
  upstreamMs += Date.now() - t0
}
```

**硬约束**：
- Content-Length缺失：**必须**不缓冲
- Content-Length不可解析：**必须**不缓冲
- Content-Length > MAX_BODY_BUFFER：**必须**不缓冲
- 以上情况：**必须**禁用微缓存，直连代理

**验证步骤**：
- [ ] PlaybackInfo POST with Content-Length: 20KB → 微缓存生效
- [ ] PlaybackInfo POST without Content-Length → 直连，无微缓存
- [ ] PlaybackInfo POST with Content-Length: 1MB → 直连，无微缓存

**风险**：低 - 只影响PlaybackInfo POST

---

## 🔒 不变量检查清单

执行前必须确认以下不变量：

### 媒体请求
- [ ] Response.body直通流式返回
- [ ] 不读取body（不调用arrayBuffer/text/json）
- [ ] 不添加会导致缓存媒体的cf选项

### Range请求
- [ ] 请求头Range透传
- [ ] 响应206/416与Content-Range/Accept-Ranges/Content-Length不被破坏
- [ ] 不落入caches.default

### m3u8
- [ ] 只缓存m3u8文本，不缓存分片
- [ ] cacheKey必须token-aware
- [ ] TTL极短（2s）
- [ ] 使用`private, max-age=2`

### PlaybackInfo POST
- [ ] cacheKey必须包含tokenHash与bodyHash
- [ ] TTL极短（3s）
- [ ] 使用`private, max-age=3`
- [ ] body过大或未知长度时自动降级为直连

### /manage API
- [ ] 所有API仍按ADMIN_TOKEN Bearer鉴权
- [ ] 导入/导出/回滚/批量删除仍兼容
- [ ] KV键不变

### WebSocket
- [ ] Upgrade请求仍返回101并附带webSocket对象
- [ ] 不因header清理失效

### Redirect
- [ ] 仍保持manual redirect
- [ ] 维持现有Location修正语义

### Android TV
- [ ] 请求侧保留Connection: keep-alive
- [ ] 响应侧保留Connection: keep-alive和Keep-Alive头

---

## 📊 验证计划

### 单元测试级别
- [ ] noTlsVerify字段已移除
- [ ] 全文搜索 `{ .` → 0命中（验证扩展运算符语法）
- [ ] CONFIG.MAX_BODY_BUFFER正确引用
- [ ] cleanupHopByHopHeaders正确删除固定列表
- [ ] cleanupHopByHopHeaders正确解析Connection值（先读后删）
- [ ] Android TV请求包含Connection: keep-alive
- [ ] 🚨 补丁1：WebSocket请求不调用cleanupHopByHopHeaders
- [ ] 🚨 补丁1：101响应不调用cleanupHopByHopHeaders
- [ ] 🚨 补丁2：请求侧不删除proxy-authenticate和proxy-authorization
- [ ] 🚨 补丁4：subreqCount只在fetch前增加

### 集成测试级别
- [ ] 测试`Connection: foo, bar`动态删除
- [ ] PlaybackInfo请求完成<4s（未缓存）
- [ ] m3u8响应包含`private, max-age=2`
- [ ] PlaybackInfo响应包含`private, max-age=3`
- [ ] 视频分片流式传输无缓冲
- [ ] Range请求返回正确字节范围
- [ ] 🚨 补丁1：WebSocket请求保留Upgrade头
- [ ] 🚨 补丁1：WebSocket响应返回101状态码
- [ ] 🚨 补丁3：视频请求无超时限制（已被P2 TTFB Watchdog替代）
- [ ] 🚨 补丁3：m3u8请求无超时限制
- [ ] 🚨 补丁3：PlaybackInfo POST无超时限制
- [ ] 🚨 补丁3：非关键API GET使用4500ms超时
- [ ] ⚡ P2：媒体请求（isVideo=true）启用TTFB Watchdog
- [ ] ⚡ P2：Range请求（hasRange=true）启用TTFB Watchdog
- [ ] ⚡ P2：m3u8请求不启用TTFB Watchdog
- [ ] ⚡ P2：WebSocket请求不启用TTFB Watchdog
- [ ] ⚡ P2：POST请求不启用TTFB Watchdog
- [ ] ⚡ P2：TTFB超时后自动重试1次
- [ ] ⚡ P2：拿到4xx/5xx响应不重试

### 生产验证级别
- [ ] 开启DEBUG=1，检查Server-Timing字段
- [ ] 验证Android TV播放无退化
- [ ] 验证WebSocket连接正常（补丁1关键验证）
- [ ] 检查m3u8微缓存生效（cache_hit=1）
- [ ] 检查PlaybackInfo微缓存生效（cache_hit=1）
- [ ] 🚨 补丁4：验证subreqCount准确反映回源次数
- [ ] ⚡ P2：验证X-Media-TTFB-Ms指标正确
- [ ] ⚡ P2：验证X-Media-Retry-Count指标正确
- [ ] ⚡ P2：验证X-Media-Timed-Out指标正确
- [ ] ⚡ P2：实际场景验证：解决0kb/s卡死问题

---

## ⚠️ 回滚计划

如果出现问题，按以下顺序回滚：

### 立即回滚触发条件
- WebSocket连接失败率>5%
- 媒体播放失败率>10%
- Android TV播放失败率>5%

### 回滚步骤
1. 使用git恢复worker.js到修改前版本
2. 执行`npm run deploy`重新部署
3. 验证核心功能恢复正常

### 分阶段回滚
如果只有部分功能异常，可以：
1. 注释掉cleanupHopByHopHeaders调用，恢复原有逻辑
2. 恢复m3u8和PlaybackInfo使用public Cache-Control
3. 恢复MAX_BODY_BUFFER为原有逻辑

---

## 📈 成功指标

### 性能指标
- **超时时间**：从2500ms增加到4500ms，减少误杀
- **Token hash**：匿名用户CPU时间减少（保持原有优化）

### 鲁棒性指标
- **RFC 7230合规**：正确处理hop-by-hop头（先读Connection再删除）
- **Content-Length缺失**：避免盲目缓冲
- **Android TV兼容性**：保持稳定播放体验

### 缓存策略指标
- **m3u8使用private**：避免中间缓存不可控复用
- **PlaybackInfo使用private**：与m3u8策略保持一致
- **边缘微缓存**：仍然通过caches.default正确控制

---

## 📝 与原计划的主要差异

### 修正点1：noTlsVerify定性
- **原计划**：TLS行为修复
- **修正版**：无效字段清理
- **验证**：确认无行为变化

### 修正点2：Android TV Connection
- **原计划**：移除请求侧Connection: keep-alive
- **修正版**：保留请求侧Connection: keep-alive
- **理由**：风险较高，兼容性优先

### 修正点3：m3u8 Cache-Control
- **原计划**：使用`public, max-age=2`
- **修正版**：使用`private, max-age=2`
- **理由**：避免中间缓存不可控复用

### 修正点4：PlaybackInfo Cache-Control（新增修正）
- **原计划**：使用`public, max-age=3`
- **修正版**：使用`private, max-age=3`
- **理由**：与m3u8策略保持一致，避免不可控复用

### 修正点5：Hop-by-hop清理顺序（新增修正）
- **原计划**：先删除Connection，再读取Connection值
- **修正版**：先读取Connection值，再删除固定列表，再删除动态字段
- **理由**：修复致命bug，确保动态清理分支生效

### 修正点6：扩展运算符语法（新增修正）
- **原计划**：文档中出现`.cfConfig`（单点）语法错误
- **修正版**：所有位置使用`...cfConfig`（三个点的扩展运算符）
- **理由**：防止AI生成不可运行代码
- **硬性验收**：全文搜索 `{ .` → 必须0命中

### 修正点7：保留重要头设置
- **原计划**：可能删除Referer/Origin
- **修正版**：保留Referer/Origin设置
- **理由**：某些上游可能依赖

### 🚨 补丁1：WebSocket Upgrade头保护（P0）
- **问题**：cleanupHopByHopHeaders无条件删除upgrade，导致WebSocket握手失败
- **修正**：请求侧`if (!isWebSocket)`条件调用；响应侧`if (response.status !== 101)`条件调用
- **理由**：WebSocket必须保留Upgrade和Connection头，否则101状态码出不来

### 🚨 补丁2：proxy-*头保留策略（P1）
- **问题**：固定列表包含proxy-authenticate和proxy-authorization，可能影响上游鉴权
- **修正**：请求侧不删除这两个头（isRequest=true参数）
- **理由**：上游可能依赖这些头，"少删比多删更稳"

### 🚨 补丁3：API超时分流规则明确化（P1）
- **问题**：API_TIMEOUT: 4500的适用范围不明确，可能误杀关键路径
- **修正**：明确哪些路径使用超时（非关键API GET），哪些路径无超时（video/m3u8/PlaybackInfo/WebSocket）
- **理由**：防止关键路径被错误限制超时

### 🚨 补丁4：subreqCount统计位置修正（P2）
- **问题**：subreqCount++在cache.put前增加，导致指标不准确
- **修正**：subreqCount++只在fetch()调用前增加，cache.put不增加
- **理由**：确保[PERF]指标准确反映回源次数

---

## 🚀 执行时间表

**预计总时间**：2-2.5小时（包括测试）

1. **Phase 1**（20分钟）：低风险修复
2. **Phase 2**（40分钟）：RFC 7230合规性
3. **Phase 3**（30分钟）：媒体请求TTFB Watchdog（P2核心功能）
4. **Phase 4**（30分钟）：缓存策略优化
5. **验证**（40分钟）：全面测试（包括P2验证）

**建议执行时间**：非高峰时段（如凌晨2-5点）

---

## ✅ 七大修正 + 四大补丁确认

### 修正1：cleanupHopByHopHeaders执行顺序
- ✅ 先读取Connection值
- ✅ 再删除固定列表
- ✅ 再删除动态字段
- ✅ Connection已在固定列表中删除

### 修正2：扩展运算符语法
- ✅ 所有`cf: { ...cfConfig }`使用三个点
- ✅ 验证规则：全文搜索`{ .`应该0命中

### 修正3：PlaybackInfo Cache-Control
- ✅ 使用`private, max-age=3`
- ✅ 与m3u8策略保持一致
- ✅ 避免中间缓存不可控复用

### 🚨 补丁1：WebSocket Upgrade头保护（P0）
- ✅ 请求侧：`if (!isWebSocket)` 条件调用cleanupHopByHopHeaders
- ✅ 响应侧：`if (response.status !== 101)` 条件调用cleanupHopByHopHeaders
- ✅ 函数参数：preserveUpgrade控制是否保留upgrade头

### 🚨 补丁2：proxy-*头保留策略（P1）
- ✅ 函数参数：isRequest=true时不删除proxy-authenticate和proxy-authorization
- ✅ 请求侧：cleanupHopByHopHeaders(proxyHeaders, false, true)
- ✅ 响应侧：cleanupHopByHopHeaders(resHeaders, false, false)

### 🚨 补丁3：API超时分流规则（P1）
- ✅ 明确使用超时的路径：非关键API GET
- ✅ 明确禁止超时的路径：video/m3u8/PlaybackInfo/WebSocket/Range
- ✅ 实现示例：useTimeout变量控制分流

### 🚨 补丁4：subreqCount统计位置（P2）
- ✅ subreqCount++只在fetch()前增加
- ✅ cache.put不增加subreqCount
- ✅ 确保[PERF]指标准确
