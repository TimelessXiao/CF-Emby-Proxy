# 最终实施计划 v2（修正版）

## 📋 执行概览

**项目**：CF-Emby-Proxy 性能优化与Bug修复（修正版）
**优先级**：P0（高优先级）
**关键修正**：
- noTlsVerify改为无效字段清理
- Hop-by-hop实现RFC 7230动态解析
- m3u8使用private Cache-Control
- 保留Android TV请求侧Connection: keep-alive

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

**验证步骤**：
- [ ] grep检查noTlsVerify → 0命中
- [ ] 确认请求行为无变化
- [ ] 确认无脚本异常
- [ ] 确认无类型错误

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

**风险**：极低 - 增加容错性

---

### Phase 2: RFC 7230合规性

#### 任务2.1：实现RFC 7230 Hop-by-hop清理

**位置**：worker.js:新增函数 + 应用位置

**目标**：完全符合RFC 7230规范的hop-by-hop头清理

**硬约束**：
- 删除固定hop-by-hop列表
- **动态删除Connection头value中列出的所有字段名**（大小写不敏感、需要trim）

**实现**：

**步骤1：新增cleanupHopByHopHeaders函数**
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
    'proxy-connection',  // 重要：Codex包含此项，Gemini遗漏
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

**步骤2：应用于请求侧**
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

// RFC 7230: 清理 hop-by-hop 头 + Connection 声明的字段
cleanupHopByHopHeaders(proxyHeaders)

// 保留Android TV Connection逻辑（关键决策）
if (isAndroidTV && !isWebSocket) {
  proxyHeaders.set('Connection', 'keep-alive')
}
```

**步骤3：应用于响应侧**
```javascript
// 在构建resHeaders后
const resHeaders = new Headers(response.headers)

// RFC 7230: 清理 hop-by-hop 头（在设置自定义响应头之前）
cleanupHopByHopHeaders(resHeaders)

resHeaders.delete('content-security-policy')
resHeaders.delete('clear-site-data')
resHeaders.set('access-control-allow-origin', '*')

// Connection optimization: Android TV uses keep-alive
if (isVideo && isAndroidTV) {
  resHeaders.set('Connection', 'keep-alive')
  resHeaders.set('Keep-Alive', 'timeout=30, max=1000')
}
```

**步骤4：PlaybackInfo缓存前也清理**
```javascript
// 在PlaybackInfo POST微缓存分支中
const resHeaders = new Headers(upstreamResp.headers)
// 清理上游返回中的 hop-by-hop 头，缓存干净的副本
cleanupHopByHopHeaders(resHeaders)
if (upstreamResp.ok && (resHeaders.get('content-type') || '').includes('application/json')) {
  resHeaders.set('Cache-Control', `public, max-age=${CONFIG.PLAYBACKINFO_TTL}`)
  // ... 缓存逻辑
}
```

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

### Phase 3: 缓存策略优化

#### 任务3.1：m3u8使用private Cache-Control

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
- 边缘微缓存：仍然通过`caches.default` + token-aware key控制
- 客户端Cache-Control：使用`private`避免共享缓存

**验证步骤**：
- [ ] m3u8响应包含`Cache-Control: private, max-age=2`
- [ ] 边缘微缓存仍然生效（检查cache_hit）
- [ ] 客户端不会产生不可控复用

**风险**：低 - 降低中间缓存风险

---

#### 任务3.2：Content-Length缺失时禁用PlaybackInfo微缓存

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
- [ ] CONFIG.MAX_BODY_BUFFER正确引用
- [ ] cleanupHopByHopHeaders正确删除固定列表
- [ ] cleanupHopByHopHeaders正确解析Connection值
- [ ] Android TV请求包含Connection: keep-alive

### 集成测试级别
- [ ] 测试`Connection: foo, bar`动态删除
- [ ] PlaybackInfo请求完成<4s（未缓存）
- [ ] m3u8响应包含`private, max-age=2`
- [ ] 视频分片流式传输无缓冲
- [ ] Range请求返回正确字节范围

### 生产验证级别
- [ ] 开启DEBUG=1，检查Server-Timing字段
- [ ] 验证Android TV播放无退化
- [ ] 验证WebSocket连接正常
- [ ] 检查m3u8微缓存生效（cache_hit=1）

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
2. 恢复m3u8使用public Cache-Control
3. 恢复MAX_BODY_BUFFER为原有逻辑

---

## 📈 成功指标

### 性能指标
- **超时时间**：从2500ms增加到4500ms，减少误杀
- **Token hash**：匿名用户CPU时间减少（保持原有优化）

### 鲁棒性指标
- **RFC 7230合规**：正确处理hop-by-hop头
- **Content-Length缺失**：避免盲目缓冲
- **Android TV兼容性**：保持稳定播放体验

### 缓存策略指标
- **m3u8使用private**：避免中间缓存不可控复用
- **边缘微缓存**：仍然通过caches.default正确控制

---

## 🚀 执行时间表

**预计总时间**：1-2小时（包括测试）

1. **Phase 1**（20分钟）：低风险修复
2. **Phase 2**（40分钟）：RFC 7230合规性
3. **Phase 3**（30分钟）：缓存策略优化
4. **验证**（30分钟）：全面测试

**建议执行时间**：非高峰时段（如凌晨2-5点）

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

### 修正点4：Hop-by-hop清理
- **原计划**：固定列表
- **修正版**：固定列表 + 动态解析Connection值
- **理由**：完全符合RFC 7230

### 修正点5：保留重要头设置
- **原计划**：可能删除Referer/Origin
- **修正版**：保留Referer/Origin设置
- **理由**：某些上游可能依赖
