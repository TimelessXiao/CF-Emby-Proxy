# 最终方案 - 代码修改清单

## Phase 1: 低风险修复

### 修改1：移除noTlsVerify无效字段

**文件**：worker.js
**位置**：约第158行

```javascript
// BEFORE
const fetchOptions = {
  method: req.method,
  headers: proxyHeaders,
  body: reqBody,
  redirect: 'manual',
  cf: { ...cfConfig, noTlsVerify: true }
}

// AFTER
const fetchOptions = {
  method: req.method,
  headers: proxyHeaders,
  body: reqBody,
  redirect: 'manual',
  cf: { ...cfConfig }
}
```

**说明**：移除被Cloudflare Workers静默忽略的无效字段

---

### 修改2：CONFIG新增MAX_BODY_BUFFER

**文件**：worker.js
**位置**：约第32行

```javascript
const CONFIG = {
  UPSTREAM_URL: 'https://your-emby-server.com',

  STATIC_REGEX: /(\.(jpg|jpeg|png|gif|css|js|ico|svg|webp|woff|woff2)|(\/Images\/(Primary|Backdrop|Logo|Thumb|Banner|Art)))/i,
  VIDEO_REGEX: /(\/Videos\/|\/Items\/.*\/Download|\/Items\/.*\/Stream)/i,
  API_CACHE_REGEX: /(\/Items\/Resume|\/Users\/.*\/Items\/)/i,

  API_TIMEOUT: 4500,  // 从2500改为4500
  ANDROID_API_TIMEOUT: 6000,

  M3U8_REGEX: /\.m3u8($|\?)/i,
  PLAYBACKINFO_REGEX: /\/PlaybackInfo/i,
  M3U8_TTL: 2,
  PLAYBACKINFO_TTL: 3,

  MAX_BODY_BUFFER: 262144,  // 新增：256KB

  ROUTE_CACHE_TTL: 60
}
```

---

## Phase 2: RFC 7230合规性

### 修改3：新增cleanupHopByHopHeaders函数

**文件**：worker.js
**位置**：约第56行之后（sha256Hex函数之后）

```javascript
// RFC 7230 hop-by-hop header cleanup:
// - Always remove fixed hop-by-hop headers.
// - Additionally, remove every field-name listed in an incoming Connection header value.
function cleanupHopByHopHeaders(headers) {
  if (!headers) return

  // Fixed hop-by-hop list (case-insensitive by Headers API)
  const fixed = [
    'connection',
    'keep-alive',
    'proxy-connection',
    'te',
    'trailer',
    'transfer-encoding',
    'upgrade',
    'proxy-authenticate',
    'proxy-authorization'
  ]

  for (const name of fixed) headers.delete(name)

  // Dynamic: parse Connection header value
  const connVal = headers.get('Connection') || headers.get('connection')
  if (connVal) {
    // Parse comma-separated field-names; case-insensitive; trim whitespace
    for (const token of connVal.split(',').map(t => t.trim()).filter(Boolean)) {
      headers.delete(token)
    }
    headers.delete('Connection')
  }
}
```

---

### 修改4：请求侧应用hop-by-hop清理

**文件**：worker.js
**位置**：约第66-76行

```javascript
// BEFORE
const proxyHeaders = new Headers(req.headers)
proxyHeaders.set('Host', targetUrl.hostname)
proxyHeaders.set('Referer', targetUrl.origin)
proxyHeaders.set('Origin', targetUrl.origin)

// 剔除杂项头
proxyHeaders.delete('cf-connecting-ip')
proxyHeaders.delete('x-forwarded-for')
proxyHeaders.delete('cf-ray')
proxyHeaders.delete('cf-visitor')

// AFTER
const proxyHeaders = new Headers(req.headers)
proxyHeaders.set('Host', targetUrl.hostname)
proxyHeaders.set('Referer', targetUrl.origin)
proxyHeaders.set('Origin', targetUrl.origin)

// 剔除杂项头
proxyHeaders.delete('cf-connecting-ip')
proxyHeaders.delete('x-forwarded-for')
proxyHeaders.delete('cf-ray')
proxyHeaders.delete('cf-visitor')

// RFC 7230: 清理 hop-by-hop 头 + Connection 声明的字段
cleanupHopByHopHeaders(proxyHeaders)
```

---

### 修改5：保留Android TV请求侧Connection逻辑

**文件**：worker.js
**位置**：约第169行

```javascript
// 保持不变（不删除此逻辑）
// Android TV：设置 keep-alive (skip for WebSocket to preserve Upgrade header)
if (isAndroidTV && !isWebSocket) {
  proxyHeaders.set('Connection', 'keep-alive')
}
```

**说明**：此逻辑在cleanupHopByHopHeaders之后执行，因此Connection: keep-alive会被保留

---

### 修改6：请求体缓冲控制

**文件**：worker.js
**位置**：约第78-82行

```javascript
// BEFORE
let reqBody = req.body
if (!['GET', 'HEAD'].includes(req.method) && !url.pathname.includes('/Upload')) {
  reqBody = await req.arrayBuffer()
  proxyHeaders.delete('content-length')
}

// AFTER
let reqBody = req.body
let canBufferBody = false

if (!['GET', 'HEAD'].includes(req.method) && !url.pathname.includes('/Upload')) {
  const clHeader = req.headers.get('content-length')
  const cl = clHeader ? parseInt(clHeader, 10) : NaN
  const clValid = Number.isFinite(cl)
  canBufferBody = clValid && cl <= CONFIG.MAX_BODY_BUFFER

  if (canBufferBody) {
    reqBody = await req.arrayBuffer()
    proxyHeaders.delete('content-length')
  } else {
    // 不缓冲：保持流式；无/无效 Content-Length 时后续禁用微缓存并直连
    reqBody = req.body
  }
}
```

---

## Phase 3: 缓存策略优化

### 修改7：响应侧应用hop-by-hop清理

**文件**：worker.js
**位置**：约第243行

```javascript
// BEFORE
const resHeaders = new Headers(response.headers)
resHeaders.delete('content-security-policy')
resHeaders.delete('clear-site-data')
resHeaders.set('access-control-allow-origin', '*')

// AFTER
const resHeaders = new Headers(response.headers)

// RFC 7230: 清理 hop-by-hop 头（在设置自定义响应头之前）
cleanupHopByHopHeaders(resHeaders)

resHeaders.delete('content-security-policy')
resHeaders.delete('clear-site-data')
resHeaders.set('access-control-allow-origin', '*')
```

---

### 修改8：m3u8使用private Cache-Control

**文件**：worker.js
**位置**：约第253行（在静态图片缓存逻辑之前）

```javascript
// 新增：m3u8 Cache-Control Strategy
if (isM3U8 && response.ok) {
  resHeaders.set('Cache-Control', `private, max-age=${CONFIG.M3U8_TTL}`);
}

// [补充] 强制静态图片缓存命中
if (isStatic && response.status === 200) {
  resHeaders.set('Cache-Control', 'public, max-age=31536000, immutable')
  resHeaders.delete('Pragma')
  resHeaders.delete('Expires')
}
```

---

### 修改9：PlaybackInfo POST条件微缓存

**文件**：worker.js
**位置**：约第179-211行

```javascript
// BEFORE
if (isPlaybackInfo && req.method === 'POST' && !hasRange) {
  const bodyHash = await sha256Hex(reqBody || '')
  // ... 微缓存逻辑
}

// AFTER
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

---

### 修改10：PlaybackInfo缓存前清理hop-by-hop头

**文件**：worker.js
**位置**：约第202行

```javascript
// 在PlaybackInfo POST微缓存分支中
const resHeaders = new Headers(upstreamResp.headers)

// 清理上游返回中的 hop-by-hop 头，缓存干净的副本
cleanupHopByHopHeaders(resHeaders)

if (upstreamResp.ok && (resHeaders.get('content-type') || '').includes('application/json')) {
  resHeaders.set('Cache-Control', `public, max-age=${CONFIG.PLAYBACKINFO_TTL}`)
  const toStore = new Response(upstreamResp.body, { status: upstreamResp.status, headers: resHeaders })
  subreqCount++
  c.executionCtx.waitUntil(caches.default.put(cacheReq, toStore.clone()))
  response = toStore
}
```

---

## 修改总结

| 修改项 | 位置 | 风险 | 优先级 |
|--------|------|------|--------|
| 移除noTlsVerify | worker.js:158 | 极低 | P1 |
| 新增MAX_BODY_BUFFER | worker.js:32 | 极低 | P1 |
| API_TIMEOUT改为4500 | worker.js:19 | 极低 | P1 |
| 新增cleanupHopByHopHeaders | worker.js:56+ | 低 | P2 |
| 请求侧清理hop-by-hop | worker.js:76 | 中 | P2 |
| 保留Android TV Connection | worker.js:169 | 低 | P2 |
| 请求体缓冲控制 | worker.js:78-82 | 低 | P2 |
| 响应侧清理hop-by-hop | worker.js:243 | 中 | P3 |
| m3u8使用private | worker.js:253 | 低 | P3 |
| PlaybackInfo条件缓存 | worker.js:179-211 | 低 | P3 |

---

## 关键决策记录

### 决策1：noTlsVerify定性
- **原计划**：TLS行为修复
- **修正版**：无效字段清理
- **依据**：用户反馈 + Cloudflare Workers文档

### 决策2：Android TV Connection
- **Codex建议**：移除请求侧Connection: keep-alive
- **Gemini建议**：保留请求侧Connection: keep-alive
- **最终决策**：保留（采用Gemini）
- **依据**：用户反馈"风险较高" + 兼容性优先

### 决策3：m3u8 Cache-Control
- **原计划**：public, max-age=2
- **修正版**：private, max-age=2
- **依据**：用户反馈 + 避免中间缓存不可控复用

### 决策4：Hop-by-hop清理
- **Codex方案**：cleanupHopByHopHeaders（包含proxy-connection）
- **Gemini方案**：cleanupHeaders（缺少proxy-connection）
- **最终决策**：采用Codex方案
- **依据**：更完整的固定列表

---

## 验证要点

### 必须验证的场景
1. ✅ noTlsVerify移除后无脚本异常
2. ✅ `Connection: foo, bar`动态删除foo和bar
3. ✅ Android TV播放无退化
4. ✅ m3u8响应包含`private, max-age=2`
5. ✅ PlaybackInfo POST without Content-Length → 直连
6. ✅ WebSocket连接正常（101状态码）

### 不变量检查
1. ✅ 媒体请求：Response.body直通流式返回
2. ✅ Range请求：206/416状态码正确
3. ✅ WebSocket：101状态码正常
4. ✅ /manage API：鉴权和功能兼容
