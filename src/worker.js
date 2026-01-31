// ====================
// Region 1: 环境与配置 (Config)
// ====================
import { Hono } from 'hono'
import { MANAGE_UI_HTML } from './ui.js'
import { Debugger } from './debug.js'

const CONFIG = {
  UPSTREAM_URL: 'https://your-emby-server.com', // Default upstream URL (can be overridden by env.UPSTREAM_URL)

  // 1. 匹配带后缀的文件
  // 2. 匹配 Emby 特有的无后缀图片路径 (/Images/Primary, /Images/Backdrop 等)
  STATIC_REGEX: /(\.(jpg|jpeg|png|gif|css|js|ico|svg|webp|woff|woff2)|(\/Images\/(Primary|Backdrop|Logo|Thumb|Banner|Art)))/i,

  // 视频流 (直连，不缓存，不重试)
  VIDEO_REGEX: /(\/Videos\/|\/Items\/.*\/Download|\/Items\/.*\/Stream)/i,

  // 慢接口微缓存 (解决 Resume 1.5s 的问题 + 库核心接口)
  // 扩展覆盖 /Items 列表接口，但排除下载、流式传输、图片路径
  API_CACHE_REGEX: /(\/Items(?!\/.*\/Download|\/.*\/Stream|\/.*\/Images)|\/Items\/Resume|\/Users\/.*\/Items\/Latest|\/Users\/.*\/Views|\/Shows\/NextUp)/i,
  API_CACHE_BYPASS_REGEX: /SortBy=Random/i,

  // API超时设置
  API_TIMEOUT: 6000,
  CRITICAL_TIMEOUT: 9000,

  // hop-by-hop keep-alive 注入开关（默认关闭，安全优先）
  ENABLE_HOP_BY_HOP_KEEPALIVE: false,

  // 播放清单与播放信息微缓存
  M3U8_REGEX: /\.m3u8($|\?)/i,
  PLAYBACKINFO_REGEX: /\/PlaybackInfo/i,
  M3U8_TTL: 2,
  PLAYBACKINFO_TTL: 3,

  // 最大允许缓冲请求体大小（字节）
  MAX_BODY_BUFFER: 262144,

  // [三级缓存] 路由配置缓存策略
  ROUTE_L1_TTL_S: 60,              // L1 内存缓存 TTL (秒)
  ROUTE_L2_SOFT_TTL_S: 60,         // L2 软 TTL (秒)
  ROUTE_L2_HARD_TTL_S: 2592000,    // L2 硬 TTL (秒, 30天)
  ROUTE_CACHE_HOST: 'route-cache.local',  // L2 缓存 key 隔离域名
  ROUTE_REFRESH_DEDUP_TTL_S: 5,    // 刷新去重窗口 (秒)

  // [阶段1-P0] 媒体/Range 请求首包超时配置
  MEDIA_TTFB_TIMEOUT_MS: 8000,        // 首包超时 8s
  MEDIA_TTFB_RETRY_MAX: 1,            // 最多重试 1 次
  MEDIA_TTFB_RETRY_BACKOFF_MIN_MS: 100,  // 重试延迟最小值
  MEDIA_TTFB_RETRY_BACKOFF_MAX_MS: 200,  // 重试延迟最大值

  // [阶段2-P0] 空 tag 图片短 TTL 缓存配置
  EMPTY_TAG_IMAGE_TTL_S: 90,          // 空 tag 匿名图片边缘缓存 TTL（秒）

  // [阶段4-P1] DEBUG 采样率（防止 header 膨胀）
  DEBUG_SAMPLE_RATE: 0.1              // 采样 10% 的请求用于 DEBUG 输出
}

// 播放器/客户端标识（用于 UA 分类与诊断，小写）
const PLAYER_TOKENS = [
  'afusekt',      // Infuse variant
  'hills',        // Desktop player
  'exoplayer',    // Android native players
  'mpv',          // Desktop player
  'infuse',       // iOS/tvOS player
  'emby',         // Official Emby apps
  'jellyfin',     // Jellyfin apps
  'roku',         // Roku platform
  'android tv',   // Android TV platform (组合词，避免误判 Android 浏览器)
  'firetv',       // Amazon Fire TV
  'google tv',    // Google TV platform
  'chromecast',   // Chromecast
  'shield',       // NVIDIA Shield
  'bravia',       // Sony TV
  'mitv'          // Xiaomi TV
]

// Cache Key 去噪白名单
const CACHE_QUERY_ALLOWLIST = new Set([
  'UserId', 'ParentId', 'Id', 'Ids', 'Limit', 'StartIndex',
  'SortBy', 'SortOrder', 'IncludeItemTypes', 'ExcludeItemTypes',
  'Recursive', 'Filters', 'Fields', 'ImageType',
  'EnableImageEnhancers', 'MinDateLastSaved',
  'EnableImages', 'EnableTotalRecordCount', 'ImageTypeLimit',
  'CollapseBoxSetItems', 'IsMissing', 'IsUnaired'
]);

// Tag 参数校验正则（用于匿名图片缓存）
const TAG_HEX_REGEX = /^[a-f0-9]{8,128}$/i
const TAG_BASE64URL_REGEX = /^[A-Za-z0-9_-]{8,128}$/


const ROUTE_POINTER_KEY = 'routes:current'
const ROUTE_VERSION_KEY = (v) => `routes:${v}`
const ROUTE_CACHE_KEY = 'routeCache'
const ANON_HASH_CACHE_KEY = 'anonHash'

// 并发去重：防止多个 isolate 同时刷新路由配置
let pendingRouteRefresh = null
let pendingRouteRefreshAt = 0

// ====================
// Region 2: 指挥官层 (Commander)
// ====================
const app = new Hono()

app.get('/manage', (c) => {
  return c.html(MANAGE_UI_HTML)
})

app.get('/manage/api/mappings', async (c) => {
  const token = getAdminToken(c)
  if (!token || token !== c.env.ADMIN_TOKEN) return unauthorized()

  const { version, mappings } = await loadRouteMappings(c.env, c.executionCtx)
  return c.json({ version, mappings }, 200, { 'Cache-Control': 'no-store' })
})

app.put('/manage/api/mappings/:sub', async (c) => {
  const token = getAdminToken(c)
  if (!token || token !== c.env.ADMIN_TOKEN) return unauthorized()

  const sub = c.req.param('sub') || ''
  const body = await c.req.json().catch(() => null)

  if (!body || !body.upstream) {
    return c.json({ error: 'upstream required' }, 400, { 'Cache-Control': 'no-store' })
  }

  const ifMatch = c.req.header('If-Match') || null
  const { version, mappings } = await loadRouteMappings(c.env, c.executionCtx)
  const nextMappings = { ...(mappings || {}) }
  nextMappings[sub] = { upstream: body.upstream, pathPrefix: body.pathPrefix || '' }

  try {
    const newVersion = await publishRouteMappings(c.env, 'manage.put', nextMappings, ifMatch || version, c.executionCtx)
    return c.json({ version: newVersion }, 200, { 'Cache-Control': 'no-store' })
  } catch (error) {
    if (error.status === 409) {
      return c.json({ error: 'Version conflict' }, 409, { 'Cache-Control': 'no-store' })
    }
    throw error
  }
})

app.delete('/manage/api/mappings/:sub', async (c) => {
  const token = getAdminToken(c)
  if (!token || token !== c.env.ADMIN_TOKEN) return unauthorized()

  const sub = c.req.param('sub') || ''
  const ifMatch = c.req.header('If-Match') || null
  const { version, mappings } = await loadRouteMappings(c.env, c.executionCtx)
  const nextMappings = { ...(mappings || {}) }
  delete nextMappings[sub]

  try {
    const newVersion = await publishRouteMappings(c.env, 'manage.delete', nextMappings, ifMatch || version, c.executionCtx)
    return c.json({ version: newVersion }, 200, { 'Cache-Control': 'no-store' })
  } catch (error) {
    if (error.status === 409) {
      return c.json({ error: 'Version conflict' }, 409, { 'Cache-Control': 'no-store' })
    }
    throw error
  }
})

app.post('/manage/api/batch-delete', async (c) => {
  const token = getAdminToken(c)
  if (!token || token !== c.env.ADMIN_TOKEN) return unauthorized()

  const body = await c.req.json().catch(() => null)
  if (!body || !Array.isArray(body.subdomains)) {
    return c.json({ error: 'subdomains array required' }, 400, { 'Cache-Control': 'no-store' })
  }

  const ifMatch = c.req.header('If-Match') || null
  const { version, mappings } = await loadRouteMappings(c.env, c.executionCtx)
  const nextMappings = { ...(mappings || {}) }

  let deletedCount = 0
  for (const sub of body.subdomains) {
    if (nextMappings[sub]) {
      delete nextMappings[sub]
      deletedCount++
    }
  }

  if (deletedCount === 0) {
    return c.json({ version, message: 'Nothing to delete' }, 200, { 'Cache-Control': 'no-store' })
  }

  try {
    const newVersion = await publishRouteMappings(c.env, 'manage.batch-delete', nextMappings, ifMatch || version, c.executionCtx)
    return c.json({ version: newVersion, count: deletedCount }, 200, { 'Cache-Control': 'no-store' })
  } catch (error) {
    if (error.status === 409) {
      return c.json({ error: 'Version conflict' }, 409, { 'Cache-Control': 'no-store' })
    }
    throw error
  }
})

app.get('/manage/api/export', async (c) => {
  const token = getAdminToken(c)
  if (!token || token !== c.env.ADMIN_TOKEN) return unauthorized()

  try {
    const ptr = await getPointerWithRetry(c.env.ROUTE_MAP, 3)
    let doc = null
    if (ptr.version) {
      try {
        doc = await getVersionDocWithRetry(c.env.ROUTE_MAP, ptr.version, 2)
      } catch {}
    }
    return c.json(doc || { version: null, mappings: {} }, 200, { 'Cache-Control': 'no-store' })
  } catch (error) {
    return c.json({ error: error.message }, 500, { 'Cache-Control': 'no-store' })
  }
})

app.post('/manage/api/import', async (c) => {
  const token = getAdminToken(c)
  if (!token || token !== c.env.ADMIN_TOKEN) return unauthorized()

  const payload = await c.req.json().catch(() => null)
  if (!payload || typeof payload.mappings !== 'object') {
    return c.json({ error: 'mappings required' }, 400, { 'Cache-Control': 'no-store' })
  }

  const ifMatch = c.req.header('If-Match') || null
  const { version } = await loadRouteMappings(c.env, c.executionCtx)

  try {
    const newVersion = await publishRouteMappings(c.env, 'manage.import', payload.mappings, ifMatch || version, c.executionCtx)
    return c.json({ version: newVersion }, 200, { 'Cache-Control': 'no-store' })
  } catch (error) {
    if (error.status === 409) {
      return c.json({ error: 'Version conflict' }, 409, { 'Cache-Control': 'no-store' })
    }
    throw error
  }
})

app.post('/manage/api/rollback', async (c) => {
  const token = getAdminToken(c)
  if (!token || token !== c.env.ADMIN_TOKEN) return unauthorized()

  const payload = await c.req.json().catch(() => ({}))
  const ptr = await getPointerWithRetry(c.env.ROUTE_MAP, 3)
  const toVersion = payload?.toVersion ? String(payload.toVersion) : (ptr.prev || null)

  if (!toVersion) {
    return c.json({ error: 'No previous version' }, 400, { 'Cache-Control': 'no-store' })
  }

  const target = await c.env.ROUTE_MAP.get(ROUTE_VERSION_KEY(toVersion), { type: 'json' })
  if (!target) {
    return c.json({ error: 'Target version not found' }, 404, { 'Cache-Control': 'no-store' })
  }

  await c.env.ROUTE_MAP.put(ROUTE_POINTER_KEY, toVersion, {
    metadata: { prev: ptr.version || null }
  })

  // 更新 L1
  globalThis[ROUTE_CACHE_KEY] = {
    version: target.version,
    mappings: target.mappings || {},
    expiresAt: Date.now() + CONFIG.ROUTE_L1_TTL_S * 1000
  }

  // 写穿 L2
  if (c.executionCtx) {
    const cache = caches.default
    const cacheHost = c.env.ROUTE_CACHE_HOST || CONFIG.ROUTE_CACHE_HOST
    const hardTtlS = CONFIG.ROUTE_L2_HARD_TTL_S
    c.executionCtx.waitUntil(writePointerToEdgeCache(cache, toVersion, cacheHost, hardTtlS))
    c.executionCtx.waitUntil(writeRouteToEdgeCache(cache, target, cacheHost, hardTtlS))
  }

  return c.json({ version: target.version }, 200, { 'Cache-Control': 'no-store' })
})

app.all('*', async (c) => {
  const req = c.req.raw
  const url = new URL(req.url)

  // 跳过管理路由，确保 /manage 在所有域名下都能访问
  if (url.pathname.startsWith('/manage')) {
    return c.notFound()
  }

  // 动态路由：根据子域选择上游
  const { version: routeVer, mappings, kvReadMs: routeKvMs } = await loadRouteMappings(c.env, c.executionCtx)
  const subdomain = subdomainOf(url.hostname)
  const chosenMapping = mappings[subdomain] || mappings['default'] || null
  const upstreamBase = mappingToBase(chosenMapping) || c.env.UPSTREAM_URL || CONFIG.UPSTREAM_URL

  // 强制使用 HTTPS 协议回源
  const targetUrl = new URL(url.pathname + url.search, upstreamBase)
  
  const proxyHeaders = new Headers(req.headers)
  proxyHeaders.set('Host', targetUrl.hostname)
  proxyHeaders.set('Referer', targetUrl.origin)
  proxyHeaders.set('Origin', targetUrl.origin)
  
  // 剔除杂项头
  proxyHeaders.delete('cf-connecting-ip')
  proxyHeaders.delete('x-forwarded-for')
  proxyHeaders.delete('cf-ray')
  proxyHeaders.delete('cf-visitor')

  // 仅缓冲关键非流式交互
  let reqBody = req.body
  let canBufferBody = false

  if (!['GET', 'HEAD'].includes(req.method) && !url.pathname.includes('/Upload')) {
    const clHeader = req.headers.get('content-length')
    const cl = clHeader ? parseInt(clHeader, 10) : NaN
    const clValid = Number.isFinite(cl)
    const isPlaybackInfo = CONFIG.PLAYBACKINFO_REGEX.test(url.pathname)

    if (isPlaybackInfo) {
      if (!clValid) {
        const { buf, truncated } = await readBodyWithLimit(req.clone(), 65536)
        if (!truncated && buf) {
          reqBody = buf
          canBufferBody = true
          proxyHeaders.delete('content-length')
        }
      } else if (cl <= 65536) {
        const { buf, truncated } = await readBodyWithLimit(req.clone(), 65536)
        if (!truncated && buf) {
          reqBody = buf
          canBufferBody = true
          proxyHeaders.delete('content-length')
        }
      }
    } else if (clValid && cl <= CONFIG.MAX_BODY_BUFFER) {
      const { buf, truncated } = await readBodyWithLimit(req.clone(), CONFIG.MAX_BODY_BUFFER)
      if (!truncated && buf) {
        reqBody = buf
        canBufferBody = true
        proxyHeaders.delete('content-length')
      }
    }
  }

  // --- 判别请求类型 ---
  const isStatic = CONFIG.STATIC_REGEX.test(url.pathname)
  const isVideo = CONFIG.VIDEO_REGEX.test(url.pathname)
  const isApiCacheable = req.method === 'GET' &&
                         CONFIG.API_CACHE_REGEX.test(url.pathname) &&
                         !CONFIG.API_CACHE_BYPASS_REGEX.test(url.search)
  const isWebSocket = (req.headers.get('Upgrade') || '').toLowerCase() === 'websocket'
  const isM3U8 = CONFIG.M3U8_REGEX.test(url.pathname)
  const isPlaybackInfo = CONFIG.PLAYBACKINFO_REGEX.test(url.pathname)
  const hasRange = !!req.headers.get('range')
  const ua = req.headers.get('user-agent') || ''
  const playerHint = getPlayerHint(ua)

  // 匿名图片缓存：仅对带有效 tag 参数的 Items 图片路径启用（大小写不敏感）
  const tagParam = url.searchParams.get('tag') || ''
  const tag = tagParam.trim()
  const hasValidTag = !!tag && (TAG_HEX_REGEX.test(tag) || TAG_BASE64URL_REGEX.test(tag))
  const isTaggedArtwork = /\/Items\/[^\/]+\/Images\/[^\/]+/i.test(url.pathname) &&
                          !/\/(Users|Persons)\//i.test(url.pathname) &&
                          hasValidTag

  if (!isWebSocket) {
    cleanupHopByHopHeaders(proxyHeaders, false, true)
  }

  //  Range 请求强制 identity 编码，避免 Range + gzip 导致的中间层异常
  if (hasRange) {
    proxyHeaders.set('Accept-Encoding', 'identity')
  }

  // HTTP/2 协议检测（RFC 7540：HTTP/2 禁止 hop-by-hop 头）
  const isHttp2 = req.cf?.httpProtocol === 'HTTP/2' || req.cf?.httpProtocol === 'HTTP/3'

  // Browser playback is out of scope
  if (CONFIG.ENABLE_HOP_BY_HOP_KEEPALIVE && !isWebSocket && !isHttp2) {
    if (!proxyHeaders.has('Connection')) {
      proxyHeaders.set('Connection', 'keep-alive')
    }
  }

  //  Token Hint 逻辑更新：检查 Query Params
  const hasTokenHint = req.headers.has('X-Emby-Token') ||
                       req.headers.has('X-MediaBrowser-Token') ||
                       url.searchParams.has('api_key') ||
                       url.searchParams.has('X-Emby-Token') ||
                       url.searchParams.has('X-MediaBrowser-Token') ||
                       req.headers.has('Authorization') ||
                       req.headers.has('X-Emby-Authorization')

  const needsCacheKey = !isVideo && !hasRange && (isM3U8 || isPlaybackInfo || isApiCacheable || (isStatic && hasTokenHint))
  const tokenResult = needsCacheKey ? await buildTokenKey(req, url) : null
  const tokenHash = tokenResult?.hash || null
  const hasRealToken = tokenResult?.hasRealToken || false
  const hasToken = tokenHash && hasRealToken

  // --- Cloudflare 策略配置 ---
  const cfConfig = {
    cacheEverything: (isStatic && (hasToken || isTaggedArtwork)),
    cacheTtl: 0,
    cacheTtlByStatus: isApiCacheable ? { "200-299": 10 } : null,
    polish: isStatic ? 'lossy' : 'off',
    minify: { javascript: isStatic, css: isStatic, html: isStatic },
    mirage: false,
    scrapeShield: false,
    apps: false,
  }

  if (isStatic && (hasToken || isTaggedArtwork)) {
    const keyUrl = new URL(targetUrl)
    if (keyUrl.searchParams.sort) keyUrl.searchParams.sort()

    if (isTaggedArtwork && !hasToken) {
      cfConfig.cacheKey = `${url.hostname}::${keyUrl.pathname}?${keyUrl.searchParams.toString()}`
    } else {
      cfConfig.cacheKey = `${url.hostname}::${keyUrl.pathname}?${keyUrl.searchParams.toString()}::${tokenHash}`
    }

    cfConfig.cacheEverything = true
    cfConfig.cacheTtl = 0
    cfConfig.cacheTtlByStatus = { "200-299": 31536000 }
  }

  //  空 tag 匿名图片短 TTL 缓存（抗抖动，减少切集时 500 错误）
  const isEmptyTag = isStatic && isEmptyTagArtwork(url) && isAnonymousImageRequest(req, url)
  if (isEmptyTag && req.method === 'GET') {
    const keyUrl = new URL(targetUrl)
    if (keyUrl.searchParams.sort) keyUrl.searchParams.sort()

    cfConfig.cacheEverything = true
    cfConfig.cacheTtl = 0
    cfConfig.cacheTtlByStatus = { "200-299": CONFIG.EMPTY_TAG_IMAGE_TTL_S }
    cfConfig.cacheKey = `${url.hostname}::${keyUrl.pathname}?${keyUrl.searchParams.toString()}`
  }

  //  API 微缓存 De-noising (基于白名单构建 CacheKey)
  if (isApiCacheable && hasToken) {
    cfConfig.cacheEverything = true
    const keyUrl = new URL(targetUrl)
    
    // De-noising: 仅保留白名单参数
    const safeParams = new URLSearchParams()
    for (const [key, val] of keyUrl.searchParams) {
      if (CACHE_QUERY_ALLOWLIST.has(key)) {
        safeParams.set(key, val)
      }
    }
    safeParams.sort()
    
    cfConfig.cacheKey = `${url.hostname}::${keyUrl.pathname}?${safeParams.toString()}::${tokenHash}`
  }

  if (isM3U8 && req.method === 'GET' && !hasRange && hasToken) {
    cfConfig.cacheEverything = true
    cfConfig.cacheTtl = CONFIG.M3U8_TTL
    const keyUrl = new URL(targetUrl)
    if (keyUrl.searchParams.sort) keyUrl.searchParams.sort()
    cfConfig.cacheKey = `${url.hostname}::${keyUrl.pathname}?${keyUrl.searchParams.toString()}::${tokenHash}`
  }

  if (hasRange) {
    cfConfig.cacheEverything = false
    cfConfig.cacheTtl = 0
    cfConfig.cacheTtlByStatus = null
  }

  const fetchOptions = {
    method: req.method,
    headers: proxyHeaders,
    body: reqBody,
    redirect: 'manual',
    cf: { ...cfConfig }
  }

  const DEBUG = c.env?.DEBUG === 'true' || c.env?.DEBUG === '1'
  const kind = isVideo ? 'media' : (hasRange ? 'range' : (isM3U8 ? 'm3u8' : (isPlaybackInfo ? 'playbackinfo' : 'api')))
  let kvReadMs = routeKvMs || 0
  let upstreamMs = 0
  let retryCount = 0
  let subreqCount = 0
  let cacheHit = 0

  try {
    let response;

    if (isPlaybackInfo && req.method === 'POST' && !hasRange && canBufferBody && hasToken) {
      const bodyHash = await sha256Hex(reqBody || '')
      const sortedParams = Array.from(url.searchParams.entries())
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([k, v]) => `${k}=${v}`)
        .join('&')
      const cacheKey = `https://cache.playbackinfo.local/${url.hostname}${url.pathname}?${sortedParams}&h=${tokenHash}&b=${bodyHash}`
      const cacheReq = new Request(cacheKey, { method: 'GET' })
      const cache = caches.default
      const cached = await cache.match(cacheReq)
      if (cached) {
        cacheHit = 1
        return new Response(cached.body, { status: cached.status, headers: cached.headers })
      }

      const t0 = Date.now()
      subreqCount++
      const upstreamResp = await fetchWithTimeout(targetUrl.toString(), fetchOptions, CONFIG.CRITICAL_TIMEOUT)
      upstreamMs += Date.now() - t0

      const resHeaders = new Headers(upstreamResp.headers)
      cleanupHopByHopHeaders(resHeaders, false, false)

      if (upstreamResp.ok && (resHeaders.get('content-type') || '').includes('application/json')) {
        resHeaders.set('Cache-Control', `private, max-age=${CONFIG.PLAYBACKINFO_TTL}`)
        const toStore = new Response(upstreamResp.body, { status: upstreamResp.status, headers: resHeaders })
        c.executionCtx.waitUntil(caches.default.put(cacheReq, toStore.clone()))
        response = toStore
      } else {
        response = upstreamResp
      }
    }

    if (!response) {
      if ((isVideo || hasRange) && !isWebSocket) {
        //  使用 TTFB 超时+单次重试机制，避免长时间 0.0kb/s 挂起
        const t0 = Date.now()
        subreqCount++
        let retryAttempt = 0
        try {
          for (let attempt = 0; attempt <= CONFIG.MEDIA_TTFB_RETRY_MAX; attempt++) {
            try {
              if (attempt > 0) {
                const jitter = CONFIG.MEDIA_TTFB_RETRY_BACKOFF_MIN_MS +
                               Math.random() * (CONFIG.MEDIA_TTFB_RETRY_BACKOFF_MAX_MS - CONFIG.MEDIA_TTFB_RETRY_BACKOFF_MIN_MS)
                await sleep(jitter)
                retryAttempt = attempt
              }

              response = await fetchWithTtfbTimeout(
                targetUrl.toString(),
                fetchOptions,
                CONFIG.MEDIA_TTFB_TIMEOUT_MS
              )
              break
            } catch (error) {
              if (error.name === 'AbortError' && attempt < CONFIG.MEDIA_TTFB_RETRY_MAX) {
                continue
              }
              throw error
            }
          }
        } catch (error) {
          retryCount = retryAttempt
          throw error
        }
        retryCount = retryAttempt
        upstreamMs += Date.now() - t0
      } else if (isWebSocket || (req.method === 'POST' && !(isPlaybackInfo && !hasRange))) {
        const t0 = Date.now()
        subreqCount++
        response = await fetch(targetUrl.toString(), fetchOptions)
        upstreamMs += Date.now() - t0
      } else {
        // [P0-1] Critical Path 逻辑更新：API Cacheable 的请求均视为关键路径
        const isCriticalPath = (isM3U8 && req.method === 'GET') || (isApiCacheable && req.method === 'GET') || (isPlaybackInfo && req.method === 'POST')

        if (isCriticalPath) {
          const t0 = Date.now()
          subreqCount++
          response = await fetchWithTimeout(targetUrl.toString(), fetchOptions, CONFIG.CRITICAL_TIMEOUT)
          upstreamMs += Date.now() - t0
        } else {
          // Browser playback is out of scope
          const timeout = CONFIG.API_TIMEOUT
          const t0 = Date.now()
          subreqCount++
          response = await fetchWithTimeout(targetUrl.toString(), fetchOptions, timeout)
          upstreamMs += Date.now() - t0
        }
      }
    }

    const resHeaders = new Headers(response.headers)

    if (response.status !== 101) {
      cleanupHopByHopHeaders(resHeaders, false, false)
    }

    resHeaders.delete('content-security-policy')
    resHeaders.delete('clear-site-data')
    resHeaders.set('access-control-allow-origin', '*')

    // Browser playback is out of scope
    if (CONFIG.ENABLE_HOP_BY_HOP_KEEPALIVE && isVideo && !isWebSocket && !isHttp2) {
      if (!resHeaders.has('Connection')) {
        resHeaders.set('Connection', 'keep-alive')
      }
      if (!resHeaders.has('Keep-Alive')) {
        resHeaders.set('Keep-Alive', 'timeout=30, max=1000')
      }
    }

    if (isM3U8 && response.ok) {
      resHeaders.set('Cache-Control', `private, max-age=${CONFIG.M3U8_TTL}`)
    }

    if (isStatic && response.status === 200) {
        if (hasToken || isTaggedArtwork) {
            resHeaders.set('Cache-Control', 'public, max-age=31536000, immutable')
            resHeaders.delete('Pragma')
            resHeaders.delete('Expires')
        } else if (isEmptyTag) {
            //  空 tag 匿名图片短 TTL 缓存响应头
            resHeaders.set('Cache-Control', `public, max-age=0, s-maxage=${CONFIG.EMPTY_TAG_IMAGE_TTL_S}`)
            resHeaders.delete('Pragma')
            resHeaders.delete('Expires')
        } else {
            resHeaders.set('Cache-Control', 'no-store, no-cache, must-revalidate')
            resHeaders.set('Pragma', 'no-cache')
            resHeaders.set('Expires', '0')
        }
    }

    if (isApiCacheable && req.method === 'GET' && hasToken && response.ok) {
      resHeaders.set('Cache-Control', 'public, max-age=0, s-maxage=10')
      resHeaders.delete('Pragma')
      resHeaders.delete('Expires')
    }

    if (DEBUG) {
      const dbg = new Debugger({ DEBUG_SAMPLE_RATE: CONFIG.DEBUG_SAMPLE_RATE })
      dbg.inject(resHeaders, {
        kind, kvReadMs, cacheHit, upstreamMs, retryCount, subreqCount, playerHint
      }, {
        method: req.method,
        pathname: url.pathname,
        status: response.status,
        isVideo,
        hasRange
      })
    }

    if (response.status === 101) {
      return new Response(null, { status: 101, webSocket: response.webSocket, headers: resHeaders })
    }

    if ([301, 302, 303, 307, 308].includes(response.status)) {
        const location = resHeaders.get('location')
        if (location) {
             const locUrl = new URL(location, targetUrl.href)
             if (locUrl.hostname === targetUrl.hostname) {
                 resHeaders.set('Location', locUrl.pathname + locUrl.search)
             }
        }
        return new Response(null, { status: response.status, headers: resHeaders })
    }

    //  图片 5xx 降级：返回 1x1 透明 PNG，避免 UI 破损图标
    if (isStatic && response.status >= 500 && /\/Images\//i.test(url.pathname)) {
      const transparentPixel = new Uint8Array([
        0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A, 0x00, 0x00, 0x00, 0x0D,
        0x49, 0x48, 0x44, 0x52, 0x00, 0x00, 0x00, 0x01, 0x00, 0x00, 0x00, 0x01,
        0x08, 0x06, 0x00, 0x00, 0x00, 0x1F, 0x15, 0xC4, 0x89, 0x00, 0x00, 0x00,
        0x0A, 0x49, 0x44, 0x41, 0x54, 0x78, 0x9C, 0x63, 0x00, 0x01, 0x00, 0x00,
        0x05, 0x00, 0x01, 0x0D, 0x0A, 0x2D, 0xB4, 0x00, 0x00, 0x00, 0x00, 0x49,
        0x45, 0x4E, 0x44, 0xAE, 0x42, 0x60, 0x82
      ])
      return new Response(transparentPixel.buffer, {
        status: 200,
        headers: new Headers({
          'Content-Type': 'image/png',
          'Cache-Control': 'no-store',
          'Content-Length': transparentPixel.length.toString()
        })
      })
    }

    return new Response(response.body, {
      status: response.status,
      headers: resHeaders
    })

  } catch (error) {
    //  错误语义化：区分 Timeout (504) 与 Bad Gateway (502)
    const isTimeout = error.name === 'AbortError' || error.message === 'Timeout' || (error.code === 23); // 23 is Cloudflare-specific generic timeout code sometimes
    const status = isTimeout ? 504 : 502
    const statusText = isTimeout ? 'Gateway Timeout' : 'Bad Gateway'

    //  增加诊断 Header：对于视频/Range 使用正确的 TTFB 超时值
    const errorHeaders = new Headers({ 'Content-Type': 'application/json' })
    if (DEBUG) {
      const timeoutMs = (isVideo || hasRange) ? CONFIG.MEDIA_TTFB_TIMEOUT_MS : CONFIG.CRITICAL_TIMEOUT
      errorHeaders.set('X-Proxy-Error', isTimeout ? `Timeout-${timeoutMs}ms` : `Upstream-${error.message}`)
    }

    const message = DEBUG ? `Proxy Error: ${error?.message || String(error)}` : statusText
    return new Response(JSON.stringify({ error: message }), {
      status: status,
      headers: errorHeaders
    })
  }
})


// ====================
// Region 3: 能力层 (Core Capabilities)
// ====================

if (!globalThis[ROUTE_CACHE_KEY]) {
  globalThis[ROUTE_CACHE_KEY] = { version: null, mappings: null, expiresAt: 0 }
}

if (!globalThis[ANON_HASH_CACHE_KEY]) {
  globalThis[ANON_HASH_CACHE_KEY] = null
}

async function getPointerWithRetry(ns, maxRetries = 3) {
  let lastError
  for (let i = 0; i < maxRetries; i++) {
    try {
      const { value, metadata } = await ns.getWithMetadata(ROUTE_POINTER_KEY)
      if (value) {
        return { version: value, prev: metadata?.prev || null }
      }
      return { version: null, prev: null }
    } catch (error) {
      lastError = error
      await sleep(50 * (i + 1))
    }
  }
  throw lastError || new Error('KV pointer read failed')
}

async function getVersionDocWithRetry(ns, version, maxRetries = 3) {
  let lastError
  for (let i = 0; i < maxRetries; i++) {
    try {
      const doc = await ns.get(ROUTE_VERSION_KEY(version), { type: 'json' })
      if (doc) return doc
      await sleep(50 * (i + 1))
    } catch (error) {
      lastError = error
      await sleep(50 * (i + 1))
    }
  }
  throw lastError || new Error(`KV version ${version} not available`)
}

// ====================
// L2 Cache Helpers (Route Config Only)
// ====================

function makeRouteCacheKey(version, cacheHost) {
  return `https://${cacheHost}/__route_config?v=${encodeURIComponent(version)}`
}

function makeRoutePointerKey(cacheHost) {
  return `https://${cacheHost}/__route_pointer`
}

async function getCachedVersion(cache, cacheHost, softTtlS) {
  try {
    const key = makeRoutePointerKey(cacheHost)
    const res = await cache.match(key)
    if (!res) return null

    const payload = await res.json().catch(() => null)
    if (!payload || !payload.version) return null

    const cachedAt = payload.cachedAt || 0
    const isStale = Date.now() - cachedAt > softTtlS * 1000
    return { version: payload.version, cachedAt, isStale }
  } catch {
    return null
  }
}

async function readRouteFromEdgeCache(cache, version, cacheHost, softTtlS) {
  try {
    const key = makeRouteCacheKey(version, cacheHost)
    const res = await cache.match(key)
    if (!res) return null

    const doc = await res.json().catch(() => null)
    if (!doc || !doc.mappings) return null

    const cachedAt = doc.cachedAt || 0
    const isStale = Date.now() - cachedAt > softTtlS * 1000
    return { doc, cachedAt, isStale }
  } catch {
    return null
  }
}

async function writeRouteToEdgeCache(cache, doc, cacheHost, hardTtlS) {
  try {
    const key = makeRouteCacheKey(doc.version, cacheHost)
    const payload = JSON.stringify({ ...doc, cachedAt: Date.now() })
    const res = new Response(payload, {
      headers: {
        'Content-Type': 'application/json',
        'Cache-Control': `public, max-age=${hardTtlS}`
      }
    })
    await cache.put(key, res)
  } catch (error) {
    console.warn('[L2 Write] Failed to write version doc:', error.message)
  }
}

async function writePointerToEdgeCache(cache, version, cacheHost, hardTtlS) {
  try {
    const key = makeRoutePointerKey(cacheHost)
    const payload = JSON.stringify({ version, cachedAt: Date.now() })
    const res = new Response(payload, {
      headers: {
        'Content-Type': 'application/json',
        'Cache-Control': `public, max-age=${hardTtlS}`
      }
    })
    await cache.put(key, res)
  } catch (error) {
    console.warn('[L2 Write] Failed to write pointer:', error.message)
  }
}

function scheduleRouteRefresh(env, executionCtx, cacheHost) {
  const now = Date.now()

  // 去重：如果已有刷新任务在进行且未超过去重窗口，直接返回
  if (pendingRouteRefresh &&
      (now - pendingRouteRefreshAt) < CONFIG.ROUTE_REFRESH_DEDUP_TTL_S * 1000) {
    return
  }

  if (!pendingRouteRefresh) {
    pendingRouteRefreshAt = now
    pendingRouteRefresh = (async () => {
      try {
        const cache = caches.default
        const hardTtlS = CONFIG.ROUTE_L2_HARD_TTL_S

        // 读取 KV
        const ptr = await getPointerWithRetry(env.ROUTE_MAP, 3)
        if (!ptr.version) {
          globalThis[ROUTE_CACHE_KEY] = {
            version: null,
            mappings: {},
            expiresAt: Date.now() + 10 * 1000
          }

          // 清理 L2 指针缓存
          try {
            // 先读取 L2 指针,只删除与其一致的版本 doc
            const l2Pointer = await getCachedVersion(cache, cacheHost, CONFIG.ROUTE_L2_SOFT_TTL_S)

            const emptyPointer = JSON.stringify({ version: null, cachedAt: Date.now() })
            const res = new Response(emptyPointer, {
              headers: {
                'Content-Type': 'application/json',
                'Cache-Control': 'public, max-age=10'
              }
            })
            await cache.put(makeRoutePointerKey(cacheHost), res)

            // 只删除与 L2 指针一致的版本 doc,避免误删
            if (l2Pointer?.version) {
              try {
                await cache.delete(makeRouteCacheKey(l2Pointer.version, cacheHost))
              } catch (e) {
                console.warn('[L2 Cleanup] Failed to delete version doc in refresh:', e.message)
              }
            }
          } catch (error) {
            console.warn('[L2 Cleanup] Failed to clear pointer in refresh:', error.message)
          }

          return
        }

        const doc = await getVersionDocWithRetry(env.ROUTE_MAP, ptr.version, 3)

        // 写入 L2
        await writePointerToEdgeCache(cache, ptr.version, cacheHost, hardTtlS)
        await writeRouteToEdgeCache(cache, doc, cacheHost, hardTtlS)

        // 更新 L1
        globalThis[ROUTE_CACHE_KEY] = {
          version: doc.version,
          mappings: doc.mappings || {},
          expiresAt: Date.now() + CONFIG.ROUTE_L1_TTL_S * 1000
        }
      } catch (error) {
        console.warn('[Route Refresh] Background refresh failed:', error.message)
      } finally {
        pendingRouteRefresh = null
      }
    })()
  }

  executionCtx?.waitUntil(pendingRouteRefresh)
}

async function loadRouteMappings(env, executionCtx = null, opts = {}) {
  const now = opts.now || Date.now()
  const cacheHost = env.ROUTE_CACHE_HOST || CONFIG.ROUTE_CACHE_HOST
  const softTtlS = CONFIG.ROUTE_L2_SOFT_TTL_S
  const hardTtlS = CONFIG.ROUTE_L2_HARD_TTL_S
  const l1TtlS = CONFIG.ROUTE_L1_TTL_S

  // L1 (内存缓存)
  const l1 = globalThis[ROUTE_CACHE_KEY]
  if (l1.mappings && l1.expiresAt > now) {
    return { version: l1.version, mappings: l1.mappings, kvReadMs: 0, cacheHit: 1, source: 'L1' }
  }

  let kvReadMs = 0
  const cache = caches.default

  // L2 (Cache API)
  if (!opts.bypassL2) {
    try {
      const ptr = await getCachedVersion(cache, cacheHost, softTtlS)
      if (ptr?.version) {
        const hit = await readRouteFromEdgeCache(cache, ptr.version, cacheHost, softTtlS)
        if (hit?.doc) {
          // 更新 L1
          globalThis[ROUTE_CACHE_KEY] = {
            version: hit.doc.version,
            mappings: hit.doc.mappings || {},
            expiresAt: now + l1TtlS * 1000
          }

          // 软 TTL 过期 → 后台刷新
          if (ptr.isStale || hit.isStale) {
            scheduleRouteRefresh(env, executionCtx, cacheHost)
          }

          return {
            version: hit.doc.version,
            mappings: hit.doc.mappings || {},
            kvReadMs,
            cacheHit: 1,
            source: 'L2'
          }
        }
      }
    } catch (error) {
      console.warn('[L2 Read] Cache API failed, falling back to KV:', error.message)
    }
  }

  // L3 (KV)
  try {
    const t0 = Date.now()
    const ptr = await getPointerWithRetry(env.ROUTE_MAP, 3)
    kvReadMs += Date.now() - t0

    if (!ptr.version) {
      globalThis[ROUTE_CACHE_KEY] = {
        version: null,
        mappings: {},
        expiresAt: now + 10 * 1000
      }

      // 清理 L2 指针缓存,避免陈旧配置持续服务
      executionCtx?.waitUntil((async () => {
        try {
          // 先读取 L2 指针,只删除与其一致的版本 doc
          const l2Pointer = await getCachedVersion(cache, cacheHost, softTtlS)

          const emptyPointer = JSON.stringify({ version: null, cachedAt: Date.now() })
          const res = new Response(emptyPointer, {
            headers: {
              'Content-Type': 'application/json',
              'Cache-Control': 'public, max-age=10'
            }
          })
          await cache.put(makeRoutePointerKey(cacheHost), res)

          // 只删除与 L2 指针一致的版本 doc,避免误删
          if (l2Pointer?.version) {
            try {
              await cache.delete(makeRouteCacheKey(l2Pointer.version, cacheHost))
            } catch (e) {
              console.warn('[L2 Cleanup] Failed to delete version doc:', e.message)
            }
          }
        } catch (error) {
          console.warn('[L2 Cleanup] Failed to clear pointer:', error.message)
        }
      })())

      return { version: null, mappings: {}, kvReadMs, cacheHit: 0, source: 'EMPTY' }
    }

    const t1 = Date.now()
    const doc = await getVersionDocWithRetry(env.ROUTE_MAP, ptr.version, 3)
    kvReadMs += Date.now() - t1

    // 写穿 L2 + 更新 L1
    executionCtx?.waitUntil(writePointerToEdgeCache(cache, ptr.version, cacheHost, hardTtlS))
    executionCtx?.waitUntil(writeRouteToEdgeCache(cache, doc, cacheHost, hardTtlS))

    globalThis[ROUTE_CACHE_KEY] = {
      version: doc.version,
      mappings: doc.mappings || {},
      expiresAt: now + l1TtlS * 1000
    }

    return {
      version: doc.version,
      mappings: doc.mappings || {},
      kvReadMs,
      cacheHit: 0,
      source: 'KV'
    }
  } catch (error) {
    // 降级：使用 stale L1
    if (l1?.mappings) {
      console.warn('[KV Fallback] Using stale L1 cache due to KV error:', error.message)
      return {
        version: l1.version,
        mappings: l1.mappings,
        kvReadMs,
        cacheHit: 0,
        source: 'STALE'
      }
    }

    console.error('[KV Fatal] No cached routes, using empty mappings. KV error:', error.message)
    return { version: null, mappings: {}, kvReadMs, cacheHit: 0, source: 'EMPTY' }
  }
}

async function publishRouteMappings(env, editor, newMappings, expectedVersion, executionCtx = null) {
  const ptr = await getPointerWithRetry(env.ROUTE_MAP, 3)
  const currentVersion = ptr.version

  if ((expectedVersion || null) !== (currentVersion || null)) {
    const error = new Error('Version conflict')
    error.status = 409
    throw error
  }

  const now = Date.now()
  const shanghaiTime = formatShanghaiTime(now) || new Date(now).toISOString()

  const newVersion = `v${now}`
  const doc = {
    version: newVersion,
    ts: shanghaiTime,
    editor: editor || 'unknown',
    prev: currentVersion || null,
    mappings: newMappings || {}
  }

  await env.ROUTE_MAP.put(ROUTE_VERSION_KEY(newVersion), JSON.stringify(doc))
  await env.ROUTE_MAP.put(ROUTE_POINTER_KEY, newVersion, {
    metadata: { prev: currentVersion || null }
  })

  // 更新 L1
  globalThis[ROUTE_CACHE_KEY] = {
    version: newVersion,
    mappings: doc.mappings,
    expiresAt: Date.now() + CONFIG.ROUTE_L1_TTL_S * 1000
  }

  // 写穿 L2
  if (executionCtx) {
    const cache = caches.default
    const cacheHost = env.ROUTE_CACHE_HOST || CONFIG.ROUTE_CACHE_HOST
    const hardTtlS = CONFIG.ROUTE_L2_HARD_TTL_S
    executionCtx.waitUntil(writePointerToEdgeCache(cache, newVersion, cacheHost, hardTtlS))
    executionCtx.waitUntil(writeRouteToEdgeCache(cache, doc, cacheHost, hardTtlS))
  }

  return newVersion
}

function subdomainOf(hostname) {
  const parts = (hostname || '').split('.')
  if (parts.length <= 2) return ''
  return parts[0]
}

function mappingToBase(mapping) {
  if (!mapping) return null
  try {
    const base = new URL(mapping.upstream)
    const prefix = (mapping.pathPrefix || '').trim()
    if (!prefix) return base.toString()
    const merged = new URL(prefix.startsWith('/') ? prefix : `/${prefix}`, base)
    return merged.toString()
  } catch {
    return null
  }
}

async function fetchWithTimeout(url, options, timeout) {
  const controller = new AbortController();
  const id = setTimeout(() => controller.abort(), timeout);
  try {
    const response = await fetch(url, { ...options, signal: controller.signal });
    clearTimeout(id);
    return response;
  } catch (error) {
    clearTimeout(id);
    throw error;
  }
}

//  首包（TTFB）超时包装器：仅对"收到 response headers"阶段设置超时
async function fetchWithTtfbTimeout(url, options, ttfbMs) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), ttfbMs);

  try {
    const response = await fetch(url, { ...options, signal: controller.signal });
    clearTimeout(timer);
    return response;
  } catch (error) {
    clearTimeout(timer);
    throw error;
  }
}

//  首包超时 + 单次重试包装器：仅在 headers 接收超时时重试
async function fetchWithTtfbTimeoutAndRetry(url, options, ttfbMs, retryMax, backoffMinMs, backoffMaxMs) {
  let lastError

  for (let attempt = 0; attempt <= retryMax; attempt++) {
    try {
      if (attempt > 0) {
        const jitter = backoffMinMs + Math.random() * (backoffMaxMs - backoffMinMs)
        await sleep(jitter)
      }

      return await fetchWithTtfbTimeout(url, options, ttfbMs)
    } catch (error) {
      lastError = error
      const isAbort = error.name === 'AbortError'
      if (!isAbort || attempt >= retryMax) {
        throw error
      }
    }
  }

  throw lastError
}

//  检测是否为匿名图片请求（无认证令牌）
function isAnonymousImageRequest(req, url) {
  const hasAuthHeader = req.headers.has('Authorization') ||
                        req.headers.has('X-Emby-Authorization') ||
                        req.headers.has('X-Emby-Token') ||
                        req.headers.has('X-MediaBrowser-Token') ||
                        req.headers.has('Cookie')  // [优化-P0] 防止 session/cookie auth 泄露
  const hasAuthParam = url.searchParams.has('api_key') ||
                       url.searchParams.has('X-Emby-Token') ||
                       url.searchParams.has('X-MediaBrowser-Token')
  return !hasAuthHeader && !hasAuthParam
}

//  检测是否为空 tag Artwork 请求（用于短 TTL 缓存）
function isEmptyTagArtwork(url) {
  const isImagePath = /\/Items\/[^\/]+\/Images\/[^\/]+/i.test(url.pathname)
  const notUserPath = !/\/(Users|Persons)\//i.test(url.pathname)
  const hasEmptyTag = !url.searchParams.get('tag')
  return isImagePath && notUserPath && hasEmptyTag
}

// ====================
// Region 4: 支撑层 (Support)
// ====================
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

function formatShanghaiTime(timestamp) {
  try {
    const date = new Date(timestamp)
    if (isNaN(date.getTime())) return null
    const parts = new Intl.DateTimeFormat('en-US', {
      timeZone: 'Asia/Shanghai',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
      hour12: false
    }).formatToParts(date)
    const get = (type) => parts.find(p => p.type === type)?.value || '00'
    return `${get('year')}-${get('month')}-${get('day')}T${get('hour')}:${get('minute')}:${get('second')}+08:00`
  } catch (e) {
    return null
  }
}

function getPlayerHint(ua) {
  if (!ua) return null
  const uaLower = ua.toLowerCase()
  const hit = PLAYER_TOKENS.find((token) => uaLower.includes(token))
  return hit || null
}

async function sha256Hex(input) {
  let data
  if (typeof input === 'string') {
    const encoder = new TextEncoder()
    data = encoder.encode(input)
  } else if (input instanceof ArrayBuffer) {
    data = input
  } else if (input instanceof Uint8Array) {
    data = input.buffer
  } else {
    const encoder = new TextEncoder()
    data = encoder.encode(String(input))
  }
  const hashBuffer = await crypto.subtle.digest('SHA-256', data)
  const hashArray = Array.from(new Uint8Array(hashBuffer))
  return hashArray.map(b => b.toString(16).padStart(2, '0')).join('')
}

async function buildTokenKey(req, url) {
  const headers = req.headers
  const params = url.searchParams

  // [P0-4] 支持 Query Token (X-Emby-Token / X-MediaBrowser-Token)
  let token = headers.get('X-Emby-Token') ||
              headers.get('X-MediaBrowser-Token') ||
              params.get('api_key') ||
              params.get('X-Emby-Token') ||
              params.get('X-MediaBrowser-Token') ||
              null

  const auth = headers.get('Authorization') || headers.get('X-Emby-Authorization') || ''
  if (!token && auth) {
    const tokenMatch = auth.match(/Token="?([^",\s]+)"?/i)
    if (tokenMatch) {
      token = tokenMatch[1]
    } else if (/^Bearer\s+(.+)/i.test(auth)) {
      token = auth.replace(/^Bearer\s+/i, '').trim()
    }
  }

  let deviceId = headers.get('X-Emby-Device-Id') ||
                 headers.get('X-Device-Id') ||
                 null
  if (!deviceId && auth) {
    const deviceMatch = auth.match(/DeviceId="?([^",\s]+)"?/i)
    if (deviceMatch) deviceId = deviceMatch[1]
  }

  // 安全：仅在有真实 token 时使用 token 作为缓存键的一部分
  // 如果仅有 deviceId 而无 token，视为匿名请求
  const tokenPart = token || 'anon'
  const devicePart = deviceId || 'nodev'
  const hash = await sha256Hex(`${tokenPart}:${devicePart}`)

  // 返回 hash 和 token 存在性信息
  return { hash, hasRealToken: !!token }
}

async function readBodyWithLimit(req, maxBytes) {
  const reader = req.body?.getReader()
  if (!reader) return { buf: null, truncated: false }

  const chunks = []
  let totalBytes = 0

  try {
    while (true) {
      const { done, value } = await reader.read()
      if (done) break

      totalBytes += value.byteLength
      if (totalBytes > maxBytes) {
        await reader.cancel()
        return { buf: null, truncated: true }
      }
      chunks.push(value)
    }

    const merged = new Uint8Array(totalBytes)
    let offset = 0
    for (const chunk of chunks) {
      merged.set(chunk, offset)
      offset += chunk.byteLength
    }
    return { buf: merged.buffer, truncated: false }
  } catch (error) {
    return { buf: null, truncated: true }
  }
}

// RFC 7230 hop-by-hop header cleanup (CORRECT ORDER + WebSocket Protection)
function cleanupHopByHopHeaders(headers, preserveUpgrade = false, isRequest = false) {
  if (!headers) return

  const connVal = headers.get('Connection') || headers.get('connection')
  const dynamicHopByHop = []
  if (connVal) {
    for (const token of connVal.split(',').map(t => t.trim()).filter(Boolean)) {
      dynamicHopByHop.push(token.toLowerCase())
    }
  }

  const fixed = [
    'keep-alive',
    'proxy-connection',
    'te',
    'trailer',
    'transfer-encoding'
  ]

  if (!isRequest) {
    fixed.push('proxy-authenticate', 'proxy-authorization')
  }

  if (!preserveUpgrade) {
    fixed.push('connection', 'upgrade')
  }

  for (const name of fixed) {
    headers.delete(name)
  }

  for (const name of dynamicHopByHop) {
    if (preserveUpgrade && (name === 'upgrade' || name === 'connection')) continue
    headers.delete(name)
  }
}

// --- /manage Management Endpoints ---
function unauthorized() {
  return new Response(JSON.stringify({ error: 'Unauthorized' }), {
    status: 401,
    headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }
  })
}

function getAdminToken(c) {
  const authHeader = c.req.header('Authorization') || ''
  const match = authHeader.match(/^Bearer\s+(.+)/i)
  return match ? match[1].trim() : null
}


export default app