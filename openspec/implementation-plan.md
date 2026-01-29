# 最终实施计划

## 📋 执行概览

**项目**：CF-Emby-Proxy 性能优化与Bug修复
**优先级**：P0（高优先级）
**预计影响**：
- KV阻塞：433ms → 0ms（stale-while-revalidate）
- 媒体请求：降低outcome=canceled概率
- m3u8起播：2s微缓存生效

---

## 🎯 任务清单（按实施顺序）

### Phase 1: 基础修复（低风险，立即执行）

#### 任务1.1：修复TLS验证配置错误
**位置**：worker.js:158
**问题**：使用了无效的`noTlsVerify: true`
**修复**：
```javascript
// BEFORE
cf: { ...cfConfig, noTlsVerify: true }

// AFTER
cf: { ...cfConfig, tlsVerifyOrigin: false }
```
**风险**：低 - 修复配置错误，不改变行为
**验证**：测试自签名证书的上游服务器

---

#### 任务1.2：修复WebSocket检测逻辑
**位置**：worker.js:88
**问题**：大小写敏感的字符串比较
**修复**：
```javascript
// BEFORE
const isWebSocket = req.headers.get('Upgrade') === 'websocket'

// AFTER
const upgradeHeader = req.headers.get('upgrade') || req.headers.get('Upgrade') || ''
const isWebSocket = upgradeHeader.toLowerCase() === 'websocket'
```
**风险**：低 - 增强兼容性
**验证**：测试WebSocket连接（Emby实时功能）

---

#### 任务7：Token认证逻辑重构
**位置**：worker.js:58-88
**目标**：减少匿名用户的crypto调用
**修改**：
1. 拆分buildTokenKey为两个函数：
   - `getAuthParts(req, url)` - 同步提取token/deviceId
   - `getTokenHash(authParts, anonHash)` - 只在需要时hash

2. 优化hasToken检查：
```javascript
// BEFORE
const tokenHash = needsCacheKey ? await buildTokenKey(req, url) : null
const hasToken = tokenHash && tokenHash !== globalThis[ANON_HASH_CACHE_KEY]

// AFTER
const authParts = getAuthParts(req, url);
const hasToken = !!authParts.token; // 同步检查
let tokenHash = null;
if (needsCacheKey || (isPlaybackInfo && req.method === 'POST' && !hasRange)) {
  tokenHash = await getTokenHash(authParts, globalThis[ANON_HASH_CACHE_KEY]);
}
```

**收益**：
- 匿名用户：减少100% crypto调用
- hasToken检查：从async变为sync

**风险**：低 - 逻辑等价，只优化调用时机
**验证**：
- 测试匿名访问（无token）
- 测试认证访问（有token）
- 验证缓存key一致性

---

#### 任务4：修复m3u8微缓存失效问题
**位置**：worker.js:85-90
**问题**：m3u8被VIDEO_REGEX误分类为video，导致微缓存不生效
**修复**：
```javascript
// BEFORE
const isStatic = CONFIG.STATIC_REGEX.test(url.pathname)
const isVideo = CONFIG.VIDEO_REGEX.test(url.pathname)
const isM3U8 = CONFIG.M3U8_REGEX.test(url.pathname)

// AFTER
const isStatic = CONFIG.STATIC_REGEX.test(url.pathname)
const isM3U8 = CONFIG.M3U8_REGEX.test(url.pathname)
const isVideo = CONFIG.VIDEO_REGEX.test(url.pathname) && !isM3U8 // 排除m3u8
```

**响应头强制覆盖**（worker.js:响应处理部分）：
```javascript
// 新增：强制m3u8微缓存命中
if (isM3U8 && response.status === 200 && hasToken) {
  resHeaders.set('Cache-Control', `public, max-age=${CONFIG.M3U8_TTL}`)
  resHeaders.delete('Pragma')
  resHeaders.delete('Expires')
}
```

**收益**：
- HLS播放起播速度提升
- 拖动/seek体验改善

**风险**：低 - 只影响m3u8分类
**验证**：
- 测试HLS播放（.m3u8文件）
- 检查Server-Timing中的cache_hit
- 验证m3u8不被当作video处理

---

### Phase 2: 性能优化（中风险，高收益）

#### 任务2：KV Stale-While-Revalidate（最高优先级）
**位置**：worker.js:96-176
**目标**：避免路由表过期时阻塞请求（433ms → 0ms）

**修改1：全局缓存结构**
```javascript
// BEFORE
if (!globalThis[ROUTE_CACHE_KEY]) {
  globalThis[ROUTE_CACHE_KEY] = { version: null, mappings: null, expiresAt: 0 }
}

// AFTER
if (!globalThis[ROUTE_CACHE_KEY]) {
  globalThis[ROUTE_CACHE_KEY] = {
    version: null,
    mappings: null,
    expiresAt: 0,
    refreshInFlight: null // 新增：singleflight标记
  }
}
```

**修改2：loadRouteMappings函数重写**
```javascript
async function loadRouteMappings(env, executionCtx) {
  const now = Date.now()
  const cache = globalThis[ROUTE_CACHE_KEY]

  // 路径1: Fresh hit（缓存未过期）
  if (cache.mappings && cache.expiresAt > now) {
    return { version: cache.version, mappings: cache.mappings, kvReadMs: 0, routeStale: 0, routeRefresh: 0 }
  }

  // 路径2: Stale-While-Revalidate（缓存过期但有mappings）
  if (cache.mappings && cache.expiresAt <= now) {
    let scheduled = 0
    if (!cache.refreshInFlight) {
      scheduled = 1
      const p = (async () => {
        try {
          const ptr = await getPointerWithRetry(env.ROUTE_MAP, 3)
          if (!ptr.version) {
            cache.version = null
            cache.mappings = {}
            cache.expiresAt = Date.now() + 10 * 1000
            return
          }
          const doc = await getVersionDocWithRetry(env.ROUTE_MAP, ptr.version, 3)
          cache.version = doc.version
          cache.mappings = doc.mappings || {}
          cache.expiresAt = Date.now() + CONFIG.ROUTE_CACHE_TTL * 1000
        } catch (e) {
          // 失败时保持stale数据
        } finally {
          cache.refreshInFlight = null
        }
      })()
      cache.refreshInFlight = p
      try { executionCtx?.waitUntil?.(p) } catch {}
    }
    return { version: cache.version, mappings: cache.mappings, kvReadMs: 0, routeStale: 1, routeRefresh: scheduled }
  }

  // 路径3: Cold start（缓存未命中，必须阻塞）
  let kvReadMs = 0
  try {
    const t0 = Date.now()
    const ptr = await getPointerWithRetry(env.ROUTE_MAP, 3)
    kvReadMs += Date.now() - t0

    if (!ptr.version) {
      cache.version = null
      cache.mappings = {}
      cache.expiresAt = now + 10 * 1000
      return { version: null, mappings: {}, kvReadMs, routeStale: 0, routeRefresh: 0 }
    }

    const t1 = Date.now()
    const doc = await getVersionDocWithRetry(env.ROUTE_MAP, ptr.version, 3)
    kvReadMs += Date.now() - t1

    cache.version = doc.version
    cache.mappings = doc.mappings || {}
    cache.expiresAt = Date.now() + CONFIG.ROUTE_CACHE_TTL * 1000
    return { version: doc.version, mappings: doc.mappings || {}, kvReadMs, routeStale: 0, routeRefresh: 0 }
  } catch (error) {
    if (cache.mappings) {
      return { version: cache.version, mappings: cache.mappings, kvReadMs, routeStale: 1, routeRefresh: 0 }
    }
    return { version: null, mappings: {}, kvReadMs, routeStale: 0, routeRefresh: 0 }
  }
}
```

**修改3：调用处更新**
```javascript
// BEFORE
const { version: routeVer, mappings, kvReadMs: routeKvMs } = await loadRouteMappings(c.env)

// AFTER
const { version: routeVer, mappings, kvReadMs: routeKvMs, routeStale, routeRefresh } = await loadRouteMappings(c.env, c.executionCtx)
```

**收益**：
- KV阻塞从433ms降至0ms（stale场景）
- 用户请求不再等待KV读取

**风险**：中 - 可能短时间使用过期路由
**缓解**：
- 空状态使用10s短TTL
- 后台刷新失败时保持stale数据
- singleflight避免重复刷新

**验证**：
- 检查DEBUG模式的route_stale字段
- 检查kv_read;dur是否降至0
- 测试路由更新后的传播时间

---

#### 任务6：请求体缓冲控制
**位置**：worker.js:78-82, 179-211
**目标**：避免大body导致CPU/内存超限

**修改1：CONFIG新增**
```javascript
const CONFIG = {
  // ... 其他配置
  MAX_BODY_BUFFER: 262144, // 256KB
}
```

**修改2：移除默认缓冲**
```javascript
// BEFORE
let reqBody = req.body
if (!['GET', 'HEAD'].includes(req.method) && !url.pathname.includes('/Upload')) {
  reqBody = await req.arrayBuffer()
  proxyHeaders.delete('content-length')
}

// AFTER
const reqBody = req.body // 默认不缓冲
```

**修改3：PlaybackInfo POST条件缓冲**
```javascript
// BEFORE
if (isPlaybackInfo && req.method === 'POST' && !hasRange) {
  const bodyHash = await sha256Hex(reqBody || '')
  // ... 微缓存逻辑
}

// AFTER
if (isPlaybackInfo && req.method === 'POST' && !hasRange) {
  const contentLenHeader = req.headers.get('content-length')
  const contentLength = contentLenHeader ? parseInt(contentLenHeader, 10) : null
  const canBuffer = (contentLength !== null && !Number.isNaN(contentLength) && contentLength <= MAX_BODY_BUFFER)

  if (canBuffer) {
    const bodyAb = await req.clone().arrayBuffer()
    const bodyHash = await sha256Hex(bodyAb)
    // ... 微缓存逻辑
  } else {
    // Body过大或未知长度：跳过微缓存，直接代理
    const t0 = Date.now()
    subreqCount++
    response = await fetch(targetUrl.toString(), fetchOptions)
    upstreamMs += Date.now() - t0
  }
}
```

**收益**：
- 避免大body导致CPU超限
- 避免未知长度body的盲目缓冲

**风险**：低 - 只影响PlaybackInfo POST
**验证**：
- 测试正常大小的PlaybackInfo请求（<256KB）
- 测试超大body的PlaybackInfo请求（>256KB）
- 验证微缓存仍然生效

---

#### 任务5：Hop-by-Hop Header清理
**位置**：worker.js:32-38, 请求/响应处理部分
**目标**：避免hop-by-hop头导致连接问题

**修改1：新增常量**
```javascript
const HOP_BY_HOP_HEADERS = [
  'Connection', 'Keep-Alive', 'Proxy-Authenticate', 'Proxy-Authorization',
  'TE', 'Trailer', 'Transfer-Encoding', 'Upgrade'
];
```

**修改2：请求侧清理**
```javascript
// 在构建proxyHeaders后，fetch前
if (!isWebSocket) {
  HOP_BY_HOP_HEADERS.forEach(h => proxyHeaders.delete(h))
}
```

**修改3：响应侧清理**
```javascript
// 在构建resHeaders后
if (response.status !== 101) {
  HOP_BY_HOP_HEADERS.forEach(h => resHeaders.delete(h))
}
```

**修改4：移除错误的Connection设置**
```javascript
// BEFORE（删除这段代码）
if (isAndroidTV && !isWebSocket) {
  proxyHeaders.set('Connection', 'keep-alive')
}

// AFTER
// 只在响应侧设置Connection（保留原有逻辑）
if (isVideo && isAndroidTV) {
  resHeaders.set('Connection', 'keep-alive')
  resHeaders.set('Keep-Alive', 'timeout=30, max=1000')
}
```

**收益**：
- 避免hop-by-hop头导致的连接问题
- 符合RFC 7230规范

**风险**：中 - 可能影响某些特殊客户端
**缓解**：
- WebSocket场景保留Upgrade头
- 101状态码不清理响应头

**验证**：
- 测试WebSocket连接（Emby实时功能）
- 测试Android TV播放
- 测试普通浏览器播放

---

### Phase 3: 鲁棒性增强（中风险，中收益）

#### 任务3：媒体TTFB看门狗+重试
**位置**：worker.js:241-250, 212-240
**目标**：降低媒体请求outcome=canceled概率

**修改1：CONFIG新增**
```javascript
const CONFIG = {
  // ... 其他配置
  MEDIA_TTFB_MS: 6000, // 保守默认值
  MEDIA_RETRY: 1,
}
```

**修改2：新增fetchTTFBWithRetry函数**
```javascript
async function fetchTTFBWithRetry(url, options, ttfbMs, maxRetries = 1, jitterMin = 50, jitterMax = 150) {
  let attempt = 0
  while (true) {
    try {
      const resp = await fetchWithTimeout(url, options, ttfbMs)
      return { response: resp, retries: attempt }
    } catch (e) {
      if (attempt >= maxRetries) throw e
      const jitter = jitterMin + Math.floor(Math.random() * (jitterMax - jitterMin + 1))
      await sleep(jitter)
      attempt++
    }
  }
}
```

**修改3：媒体请求使用重试**
```javascript
// BEFORE
} else if (isVideo || isWebSocket || (req.method === 'POST' && !(isPlaybackInfo && !hasRange))) {
  const t0 = Date.now()
  subreqCount++
  response = await fetch(targetUrl.toString(), fetchOptions)
  upstreamMs += Date.now() - t0
}

// AFTER
} else if (isWebSocket) {
  // WebSocket -> 直接透传
  const t0 = Date.now()
  subreqCount++
  response = await fetch(targetUrl.toString(), fetchOptions)
  upstreamMs += Date.now() - t0
} else if ((isVideo || hasRange) && (req.method === 'GET' || req.method === 'HEAD')) {
  // 媒体/Range GET/HEAD: TTFB看门狗 + 单次重试
  const MEDIA_TTFB_MS = Number.parseInt(c.env?.MEDIA_TTFB_MS || '', 10) || CONFIG.MEDIA_TTFB_MS
  const MEDIA_RETRY = Number.parseInt(c.env?.MEDIA_RETRY || '', 10) || CONFIG.MEDIA_RETRY
  const t0 = Date.now()
  subreqCount++
  try {
    const { response: upstreamResp, retries } = await fetchTTFBWithRetry(
      targetUrl.toString(),
      fetchOptions,
      MEDIA_TTFB_MS,
      MEDIA_RETRY
    )
    response = upstreamResp
    retryCount = retries
  } catch (err) {
    throw err
  } finally {
    upstreamMs += Date.now() - t0
  }
} else if (req.method === 'POST' && !(isPlaybackInfo && !hasRange)) {
  // 其他POST -> 直连（无超时，无重试）
  const t0 = Date.now()
  subreqCount++
  response = await fetch(targetUrl.toString(), fetchOptions)
  upstreamMs += Date.now() - t0
}
```

**收益**：
- 降低媒体请求canceled概率
- 提升起播成功率

**风险**：中 - 可能导致双倍请求
**缓解**：
- 只重试1次（保守）
- 只对网络错误重试，不对HTTP状态码重试
- 带jitter避免重试风暴
- 默认6000ms超时（保守）

**验证**：
- 测试正常媒体播放
- 测试慢速上游（模拟高RTT）
- 检查retry字段是否正确记录
- 验证不会对401/404/416重试

---

### Phase 4: 可观测性增强（低风险，低收益）

#### 任务8：DEBUG信息增强
**位置**：worker.js:266-279
**目标**：帮助诊断LAX路由、IPv6等问题

**修改：Server-Timing增强**
```javascript
// BEFORE
if (DEBUG) {
  const timing = [
    `kind;desc="${kind}"`,
    `kv_read;dur=${kvReadMs}`,
    `cache_hit;desc="${cacheHit}"`,
    `upstream;dur=${upstreamMs}`,
    `retry;desc="${retryCount}"`,
    `subreq;desc="${subreqCount}"`
  ].join(', ');
  resHeaders.set('Server-Timing', timing);
  console.log(`[PERF] ${req.method} ${url.pathname} | Status: ${response.status} | ${timing}`);
}

// AFTER
const ip = req.headers.get('cf-connecting-ip') || '';
const ipVer = ip.includes(':') ? '6' : (ip ? '4' : 'unknown');

const timingParts = [
  `kv_read;dur=${kvReadMs}`,
  `cache_hit;desc="${cacheHit}"`,
  `upstream;dur=${upstreamMs}`,
  `subreq;desc="${subreqCount}"`
];

if (DEBUG) {
  timingParts.unshift(`kind;desc="${kind}"`);
  timingParts.push(`colo;desc="${req.cf.colo}"`);
  timingParts.push(`ip_ver;desc="${ipVer}"`);
  timingParts.push(`route_stale;desc="${routeStale}"`);
  timingParts.push(`route_refresh;desc="${routeRefresh}"`);
  timingParts.push(`route_ver;desc="${routeVer || 'none'}"`);
  timingParts.push(`sub;desc="${subdomain || 'none'}"`);
  timingParts.push(`retry;desc="${retryCount}"`);
}

const timing = timingParts.join(', ');
if (timing) resHeaders.set('Server-Timing', timing);

if (DEBUG) {
  console.log(`[PERF] ${req.method} ${url.pathname} | Status: ${response.status} | ${timing}`);
}
```

**新增字段**：
- `colo`：PoP位置（如HKG、LAX）
- `ip_ver`：IPv4/IPv6
- `route_stale`：路由是否过期（0/1）
- `route_refresh`：是否触发后台刷新（0/1）
- `route_ver`：当前路由版本
- `sub`：匹配的子域名
- `retry`：重试次数

**收益**：
- 快速定位LAX路由问题
- 识别IPv6相关问题
- 监控KV刷新状态

**风险**：极低 - 只在DEBUG模式生效
**验证**：
- 开启DEBUG=1
- 检查Server-Timing头包含所有字段
- 验证不泄露敏感信息（token、完整IP）

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

### PlaybackInfo POST
- [ ] cacheKey必须包含tokenHash与bodyHash
- [ ] TTL极短（3s）
- [ ] body过大时自动降级为直连

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

---

## 📊 验证计划

### 单元测试级别
- [ ] buildTokenKey()不被调用for isVideo=true
- [ ] buildTokenKey()不被调用for hasRange=true
- [ ] buildTokenKey()仍被调用for cacheable requests
- [ ] 空KV状态使用10s TTL
- [ ] 非空KV状态使用60s TTL

### 集成测试级别
- [ ] PlaybackInfo请求完成<4s（未缓存）
- [ ] m3u8请求完成<3s（未缓存）
- [ ] 视频分片流式传输无缓冲
- [ ] Range请求返回正确字节范围
- [ ] 无双重fetch on timeout（检查subrequest count）

### 生产验证级别
- [ ] 开启DEBUG=1，检查Server-Timing字段
- [ ] 监控kv_read;dur是否降至0（stale场景）
- [ ] 监控retry字段是否正确记录
- [ ] 检查outcome=canceled是否减少
- [ ] 验证m3u8微缓存生效（cache_hit=1）

---

## ⚠️ 回滚计划

如果出现问题，按以下顺序回滚：

### 立即回滚触发条件
- WebSocket连接失败率>5%
- 媒体播放失败率>10%
- KV读取错误率>1%

### 回滚步骤
1. 使用git恢复worker.js到修改前版本
2. 执行`npm run deploy`重新部署
3. 验证核心功能恢复正常

### 分阶段回滚
如果只有部分功能异常，可以：
1. 注释掉fetchTTFBWithRetry调用，恢复直接fetch
2. 注释掉HOP_BY_HOP_HEADERS清理逻辑
3. 恢复loadRouteMappings为原版本

---

## 📈 成功指标

### 性能指标
- **KV阻塞**：kv_read;dur从433ms峰值降至0ms（stale场景）
- **Token hash**：匿名用户CPU时间减少（无法直接测量，通过总CPU时间推断）
- **m3u8起播**：cache_hit=1出现频率提升

### 鲁棒性指标
- **媒体请求**：outcome=canceled比例降低
- **请求体缓冲**：无CPU超限错误
- **Header清理**：无连接异常

### 可观测性指标
- **DEBUG模式**：Server-Timing包含所有新字段
- **问题定位**：可快速识别LAX路由、KV阻塞

---

## 🚀 执行时间表

**预计总时间**：2-3小时（包括测试）

1. **Phase 1**（30分钟）：基础修复
2. **Phase 2**（60分钟）：性能优化
3. **Phase 3**（30分钟）：鲁棒性增强
4. **Phase 4**（15分钟）：可观测性增强
5. **验证**（30分钟）：全面测试

**建议执行时间**：非高峰时段（如凌晨2-5点）
