import { Hono } from 'hono'

const CONFIG = {
  UPSTREAM_URL: 'https://your-emby-server.com', // Default upstream URL (can be overridden by env.UPSTREAM_URL)

  // [关键修复]
  // 1. 匹配带后缀的文件
  // 2. 匹配 Emby 特有的无后缀图片路径 (/Images/Primary, /Images/Backdrop 等)
  STATIC_REGEX: /(\.(jpg|jpeg|png|gif|css|js|ico|svg|webp|woff|woff2)|(\/Images\/(Primary|Backdrop|Logo|Thumb|Banner|Art)))/i,

  // 视频流 (直连，不缓存，不重试)
  VIDEO_REGEX: /(\/Videos\/|\/Items\/.*\/Download|\/Items\/.*\/Stream)/i,

  // [P0-1 & P0-2] 慢接口微缓存 (解决 Resume 1.5s 的问题 + 库核心接口)
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

  // 路由表内存缓存 TTL（秒）
  ROUTE_CACHE_TTL: 60,

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
  'exoplayer',    // Android native players
  'mpv',          // Desktop player
  'hills',        // Desktop player
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

// [P0-3] Cache Key 去噪白名单（扩展版）
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

const app = new Hono()

// --- Utility Functions ---
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

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

// --- KV-backed Dynamic Routing ---
const ROUTE_POINTER_KEY = 'routes:current'
const ROUTE_VERSION_KEY = (v) => `routes:${v}`
const ROUTE_CACHE_KEY = 'routeCache'
const ANON_HASH_CACHE_KEY = 'anonHash'

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

async function loadRouteMappings(env) {
  const now = Date.now()
  const cache = globalThis[ROUTE_CACHE_KEY]

  if (cache.mappings && cache.expiresAt > now) {
    return { version: cache.version, mappings: cache.mappings, kvReadMs: 0 }
  }

  let kvReadMs = 0
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
      return { version: null, mappings: {}, kvReadMs }
    }

    const t1 = Date.now()
    const doc = await getVersionDocWithRetry(env.ROUTE_MAP, ptr.version, 3)
    kvReadMs += Date.now() - t1

    globalThis[ROUTE_CACHE_KEY] = {
      version: doc.version,
      mappings: doc.mappings || {},
      expiresAt: now + CONFIG.ROUTE_CACHE_TTL * 1000
    }
    return { version: doc.version, mappings: doc.mappings || {}, kvReadMs }
  } catch (error) {
    if (cache.mappings) {
      console.warn('[KV Fallback] Using stale cache due to KV error:', error.message)
      return { version: cache.version, mappings: cache.mappings, kvReadMs }
    }
    console.error('[KV Fatal] No cached routes, using default upstream. KV error:', error.message)
    return { version: null, mappings: {}, kvReadMs }
  }
}

async function publishRouteMappings(env, editor, newMappings, expectedVersion) {
  const ptr = await getPointerWithRetry(env.ROUTE_MAP, 3)
  const currentVersion = ptr.version

  if ((expectedVersion || null) !== (currentVersion || null)) {
    const error = new Error('Version conflict')
    error.status = 409
    throw error
  }

  const newVersion = `v${Date.now()}`
  const doc = {
    version: newVersion,
    ts: new Date().toISOString(),
    editor: editor || 'unknown',
    prev: currentVersion || null,
    mappings: newMappings || {}
  }

  await env.ROUTE_MAP.put(ROUTE_VERSION_KEY(newVersion), JSON.stringify(doc))
  await env.ROUTE_MAP.put(ROUTE_POINTER_KEY, newVersion, {
    metadata: { prev: currentVersion || null }
  })

  globalThis[ROUTE_CACHE_KEY] = {
    version: newVersion,
    mappings: doc.mappings,
    expiresAt: Date.now() + CONFIG.ROUTE_CACHE_TTL * 1000
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

// [阶段1-P0] 首包（TTFB）超时包装器：仅对"收到 response headers"阶段设置超时
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

// [阶段1-P0] 首包超时 + 单次重试包装器：仅在 headers 接收超时时重试
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

// [阶段2-P0] 检测是否为匿名图片请求（无认证令牌）
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

// [阶段2-P0] 检测是否为空 tag Artwork 请求（用于短 TTL 缓存）
function isEmptyTagArtwork(url) {
  const isImagePath = /\/Items\/[^\/]+\/Images\/[^\/]+/i.test(url.pathname)
  const notUserPath = !/\/(Users|Persons)\//i.test(url.pathname)
  const hasEmptyTag = !url.searchParams.get('tag')
  return isImagePath && notUserPath && hasEmptyTag
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

app.get('/manage', (c) => {
  return c.html(`<!DOCTYPE html>
<html lang="zh-CN">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>CF Emby 代理管理器</title>
  <style>
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body { font-family: system-ui, -apple-system, sans-serif; background: #101010; color: #E0E0E0; padding: 20px; }
    .container { max-width: 1200px; margin: 0 auto; }
    h1 { color: #52B54B; margin-bottom: 8px; }
    .subtitle { color: #A0A0A0; margin-bottom: 24px; font-size: 14px; }
    .card { background: #202020; border-radius: 8px; padding: 20px; margin-bottom: 20px; }
    .card h2 { color: #52B54B; margin-bottom: 16px; font-size: 18px; }
    .form-group { margin-bottom: 16px; }
    label { display: block; margin-bottom: 4px; font-size: 14px; color: #A0A0A0; }
    input, textarea { width: 100%; padding: 10px; background: #2a2a2a; border: 1px solid #333; border-radius: 4px; color: #E0E0E0; font-size: 14px; }
    input:focus, textarea:focus { outline: none; border-color: #52B54B; }
    button { padding: 10px 20px; background: #52B54B; color: white; border: none; border-radius: 4px; cursor: pointer; font-size: 14px; font-weight: 500; }
    button:hover { background: #43943d; }
    button.secondary { background: #333; }
    button.secondary:hover { background: #444; }
    button.danger { background: #E53935; }
    button.danger:hover { background: #c62828; }
    .actions { display: flex; gap: 8px; margin-bottom: 16px; }
    table { width: 100%; border-collapse: collapse; }
    th, td { text-align: left; padding: 12px; border-bottom: 1px solid #333; }
    th { color: #52B54B; font-weight: 500; }
    td { color: #E0E0E0; }
    .btn-group { display: flex; gap: 8px; }
    .btn-sm { padding: 6px 12px; font-size: 13px; }
    #toast { position: fixed; top: 20px; right: 20px; background: #52B54B; color: white; padding: 16px 20px; border-radius: 4px; display: none; box-shadow: 0 4px 12px rgba(0,0,0,0.3); }
    #toast.error { background: #E53935; }
    .loading { opacity: 0.6; pointer-events: none; }
    input[type="checkbox"] { width: 18px; height: 18px; cursor: pointer; accent-color: #52B54B; }
    .bulk-bar {
      position: fixed; bottom: 20px; left: 50%; transform: translateX(-50%);
      background: #333; border: 1px solid #52B54B;
      padding: 12px 24px; border-radius: 50px;
      display: flex; align-items: center; gap: 16px;
      box-shadow: 0 4px 20px rgba(0,0,0,0.5); z-index: 100;
      animation: slideUp 0.3s ease;
    }
    @keyframes slideUp { from { transform: translate(-50%, 100%); } to { transform: translate(-50%, 0); } }
    .bulk-bar span { color: #E0E0E0; font-size: 14px; }
    tr.selected { background: #252525 !important; border-left: 3px solid #52B54B; }
    @media (max-width: 768px) {
      thead { display: none; }
      tr { display: block; background: #202020; border: 1px solid #333; border-radius: 8px; margin-bottom: 12px; padding: 16px 16px 16px 48px; position: relative; }
      tr.selected { border-color: #52B54B; background: #252525; border-left: 3px solid #52B54B; }
      td:first-child { display: block; position: absolute; left: 12px; top: 16px; padding: 0; border: none; }
      td { display: block; padding: 4px 0; border: none; text-align: left; word-break: break-all; }
      td.col-sub { font-size: 16px; font-weight: bold; color: #fff; margin-bottom: 4px; }
      td.col-upstream { font-size: 13px; color: #A0A0A0; margin-bottom: 12px; }
      td.col-actions { border-top: 1px solid #333; padding-top: 12px; margin-top: 8px; display: flex; justify-content: flex-end; }
      .btn-sm { min-height: 44px; padding: 12px 16px; }
      .container { padding: 10px; }
      .bulk-bar { bottom: 10px; left: 10px; right: 10px; transform: none; border-radius: 8px; }
    }
  </style>
</head>
<body>
  <div class="container">
    <h1>CF Emby 代理管理器</h1>
    <p class="subtitle">管理多个 Emby 服务器的动态路由</p>

    <div class="card">
      <div class="actions">
        <button onclick="exportConfig()" class="secondary">导出配置</button>
        <button onclick="importConfig()" class="secondary">导入配置</button>
        <button onclick="rollback()" class="danger">回滚版本</button>
      </div>
      <div id="status"></div>
    </div>

    <div class="card">
      <h2>新增/更新路由</h2>
      <form id="addForm" onsubmit="addRoute(event)">
        <div class="form-group">
          <label for="subdomain">子域名（只填第一段，例如 stream）</label>
          <input type="text" id="subdomain" placeholder="例如：stream" pattern="[a-z0-9\-]+" title="只填写子域名（例如 stream），不要包含 https:// 或域名" required>
        </div>
        <div class="form-group">
          <label for="upstream">上游地址</label>
          <input type="url" id="upstream" placeholder="https://emby.example.com" required>
        </div>
        <button type="submit" id="submitBtn">新增路由</button>
        <button type="button" id="cancelBtn" onclick="cancelEdit()" style="display:none;">取消</button>
      </form>
    </div>

    <div class="card">
      <h2>已配置的路由</h2>
      <table id="routesTable">
        <thead>
          <tr>
            <th width="40"><input type="checkbox" id="selectAll" onchange="toggleSelectAll()"></th>
            <th>子域名</th>
            <th>上游地址</th>
            <th>操作</th>
          </tr>
        </thead>
        <tbody id="routesBody">
          <tr><td colspan="4" style="text-align:center;color:#A0A0A0;">加载中...</td></tr>
        </tbody>
      </table>
    </div>
  </div>

  <div id="bulkActionBar" class="bulk-bar" style="display:none;">
    <span id="selectedCount">已选择 0 项</span>
    <button onclick="batchDelete()" class="danger">删除选中</button>
  </div>

  <div id="toast"></div>

  <script>
    let token = '';
    let currentVersion = null;
    let editingSubdomain = null;
    let selectedRoutes = new Set();
    function escapeHtml(unsafe) { if (typeof unsafe !== 'string') return ''; return unsafe.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#039;'); }
    function showToast(message, isError = false) { const toast = document.getElementById('toast'); toast.textContent = message; toast.className = isError ? 'error' : ''; toast.style.display = 'block'; setTimeout(() => toast.style.display = 'none', 3000); }
    async function apiCall(endpoint, options = {}) {
      if (!token) { token = prompt('请输入管理员令牌（ADMIN_TOKEN）：'); if (!token) throw new Error('需要提供令牌'); }
      const res = await fetch(endpoint, { ...options, headers: { ...options.headers, 'Authorization': 'Bearer ' + token } });
      if (res.status === 401) { token = ''; throw new Error('令牌无效或未授权'); }
      if (!res.ok) throw new Error(await res.text());
      return res.json();
    }
    async function loadRoutes() {
      try {
        const data = await apiCall('/manage/api/mappings');
        currentVersion = data.version;
        const tbody = document.getElementById('routesBody');
        const mappings = data.mappings || {};
        const entries = Object.entries(mappings);
        if (entries.length === 0) { tbody.innerHTML = '<tr><td colspan="4" style="text-align:center;color:#A0A0A0;">暂无路由配置</td></tr>'; } else {
          tbody.innerHTML = entries.map(([sub, config]) => {
            const escapedSub = escapeHtml(sub);
            const escapedUpstream = escapeHtml(config.upstream);
            const jsEscapedSub = sub.replace(/\\\\/g, '\\\\\\\\').replace(/'/g, "\\\\'");
            const jsEscapedUpstream = config.upstream.replace(/\\\\/g, '\\\\\\\\').replace(/'/g, "\\\\'");
            return \`
            <tr data-sub="\${escapedSub}">
              <td><input type="checkbox" class="route-check" value="\${escapedSub}" onchange="updateSelectionState()"></td>
              <td class="col-sub" data-label="子域名">\${escapedSub}</td>
              <td class="col-upstream" data-label="上游地址">\${escapedUpstream}</td>
              <td class="col-actions">
                <div class="btn-group">
                  <button class="btn-sm secondary" onclick="editRoute('\${jsEscapedSub}', '\${jsEscapedUpstream}')">编辑</button>
                  <button class="btn-sm danger" onclick="deleteRoute('\${jsEscapedSub}')">删除</button>
                </div>
              </td>
            </tr>\`;
          }).join('');
        }
        const displayVersion = currentVersion ? 'v' + new Date(parseInt(currentVersion.slice(1))).toISOString().slice(0,16).replace('T',' ') : '未初始化';
        document.getElementById('status').innerHTML = \`<small style="color:#A0A0A0;">版本：\${displayVersion} | 路由数：\${entries.length}</small>\`;
      } catch (e) { showToast('加载路由失败：' + e.message, true); }
    }
    async function addRoute(e) {
      e.preventDefault();
      const form = e.target;
      const sub = document.getElementById('subdomain').value;
      const upstream = document.getElementById('upstream').value;
      try {
        form.classList.add('loading');
        const headers = { 'Content-Type': 'application/json' };
        if (currentVersion) headers['If-Match'] = currentVersion;
        if (editingSubdomain !== null && editingSubdomain !== sub) {
          const deleteResult = await apiCall(\`/manage/api/mappings/\${editingSubdomain}\`, { method: 'DELETE', headers: { 'If-Match': currentVersion } });
          if (deleteResult && deleteResult.version) { currentVersion = deleteResult.version; headers['If-Match'] = currentVersion; }
        }
        await apiCall(\`/manage/api/mappings/\${sub}\`, { method: 'PUT', headers, body: JSON.stringify({ upstream }) });
        showToast(editingSubdomain !== null ? '路由更新成功' : '路由新增成功');
        cancelEdit();
        await loadRoutes();
      } catch (e) { showToast('保存路由失败：' + e.message, true); } finally { form.classList.remove('loading'); }
    }
    function editRoute(sub, upstream) { editingSubdomain = sub; document.getElementById('subdomain').value = sub; document.getElementById('upstream').value = upstream; document.getElementById('submitBtn').textContent = '更新路由'; document.getElementById('cancelBtn').style.display = 'inline-block'; document.getElementById('subdomain').focus(); }
    function cancelEdit() { editingSubdomain = null; document.getElementById('addForm').reset(); document.getElementById('submitBtn').textContent = '新增路由'; document.getElementById('cancelBtn').style.display = 'none'; }
    function toggleSelectAll() { const master = document.getElementById('selectAll'); const checks = document.querySelectorAll('.route-check'); checks.forEach(c => { c.checked = master.checked; if (master.checked) selectedRoutes.add(c.value); else selectedRoutes.delete(c.value); }); updateSelectionState(); }
    function updateSelectionState() {
      const checks = document.querySelectorAll('.route-check'); selectedRoutes.clear();
      checks.forEach(c => { if (c.checked) selectedRoutes.add(c.value); const tr = c.closest('tr'); if (c.checked) tr.classList.add('selected'); else tr.classList.remove('selected'); });
      const master = document.getElementById('selectAll'); master.checked = checks.length > 0 && selectedRoutes.size === checks.length; master.indeterminate = selectedRoutes.size > 0 && selectedRoutes.size < checks.length;
      const bar = document.getElementById('bulkActionBar'); const countSpan = document.getElementById('selectedCount');
      if (selectedRoutes.size > 0) { bar.style.display = 'flex'; countSpan.textContent = \`已选择 \${selectedRoutes.size} 项\`; } else { bar.style.display = 'none'; }
    }
    async function batchDelete() {
      const targets = Array.from(selectedRoutes); if (targets.length === 0) return; if (!confirm(\`确定要删除选中的 \${targets.length} 个路由吗？\`)) return;
      try {
        const headers = { 'Content-Type': 'application/json' }; if (currentVersion) headers['If-Match'] = currentVersion;
        const result = await apiCall('/manage/api/batch-delete', { method: 'POST', headers, body: JSON.stringify({ subdomains: targets }) });
        showToast(\`成功删除 \${result.count} 个路由\`); selectedRoutes.clear(); document.getElementById('bulkActionBar').style.display = 'none'; await loadRoutes();
      } catch (e) { showToast('批量删除失败：' + e.message, true); }
    }
    async function deleteRoute(sub) { if (!confirm(\`确定要删除路由 "\${sub}" 吗？\`)) return; try { const headers = {}; if (currentVersion) headers['If-Match'] = currentVersion; await apiCall(\`/manage/api/mappings/\${sub}\`, { method: 'DELETE', headers }); showToast('路由删除成功'); await loadRoutes(); } catch (e) { showToast('删除路由失败：' + e.message, true); } }
    async function exportConfig() { try { const data = await apiCall('/manage/api/export'); const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' }); const url = URL.createObjectURL(blob); const a = document.createElement('a'); a.href = url; a.download = \`emby-routes-\${Date.now()}.json\`; a.click(); showToast('配置导出成功'); } catch (e) { showToast('导出配置失败：' + e.message, true); } }
    function importConfig() {
      const input = document.createElement('input'); input.type = 'file'; input.accept = 'application/json';
      input.onchange = async (e) => { try { const file = e.target.files[0]; const text = await file.text(); const data = JSON.parse(text); const headers = { 'Content-Type': 'application/json' }; if (currentVersion) headers['If-Match'] = currentVersion; await apiCall('/manage/api/import', { method: 'POST', headers, body: JSON.stringify({ mappings: data.mappings || data }) }); showToast('配置导入成功'); await loadRoutes(); } catch (e) { showToast('导入配置失败：' + e.message, true); } }; input.click();
    }
    async function rollback() { if (!confirm('确定要回滚到上一个版本吗？')) return; try { await apiCall('/manage/api/rollback', { method: 'POST', headers: { 'Content-Type': 'application/json' } }); showToast('回滚成功'); await loadRoutes(); } catch (e) { showToast('回滚失败：' + e.message, true); } }
    loadRoutes();
  </script>
</body>
</html>`)
})

app.get('/manage/api/mappings', async (c) => {
  const token = getAdminToken(c)
  if (!token || token !== c.env.ADMIN_TOKEN) return unauthorized()

  const { version, mappings } = await loadRouteMappings(c.env)
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
  const { version, mappings } = await loadRouteMappings(c.env)
  const nextMappings = { ...(mappings || {}) }
  nextMappings[sub] = { upstream: body.upstream, pathPrefix: body.pathPrefix || '' }

  try {
    const newVersion = await publishRouteMappings(c.env, 'manage.put', nextMappings, ifMatch || version)
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
  const { version, mappings } = await loadRouteMappings(c.env)
  const nextMappings = { ...(mappings || {}) }
  delete nextMappings[sub]

  try {
    const newVersion = await publishRouteMappings(c.env, 'manage.delete', nextMappings, ifMatch || version)
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
  const { version, mappings } = await loadRouteMappings(c.env)
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
    const newVersion = await publishRouteMappings(c.env, 'manage.batch-delete', nextMappings, ifMatch || version)
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
  const { version } = await loadRouteMappings(c.env)

  try {
    const newVersion = await publishRouteMappings(c.env, 'manage.import', payload.mappings, ifMatch || version)
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

  globalThis[ROUTE_CACHE_KEY] = {
    version: target.version,
    mappings: target.mappings || {},
    expiresAt: Date.now() + CONFIG.ROUTE_CACHE_TTL * 1000
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
  const { version: routeVer, mappings, kvReadMs: routeKvMs } = await loadRouteMappings(c.env)
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

  // [阶段1-P0] Range 请求强制 identity 编码，避免 Range + gzip 导致的中间层异常
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

  // [P0-4] Token Hint 逻辑更新：检查 Query Params
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

  // [阶段2-P0] 空 tag 匿名图片短 TTL 缓存（抗抖动，减少切集时 500 错误）
  const isEmptyTag = isStatic && isEmptyTagArtwork(url) && isAnonymousImageRequest(req, url)
  if (isEmptyTag && req.method === 'GET') {
    const keyUrl = new URL(targetUrl)
    if (keyUrl.searchParams.sort) keyUrl.searchParams.sort()

    cfConfig.cacheEverything = true
    cfConfig.cacheTtl = 0
    cfConfig.cacheTtlByStatus = { "200-299": CONFIG.EMPTY_TAG_IMAGE_TTL_S }
    cfConfig.cacheKey = `${url.hostname}::${keyUrl.pathname}?${keyUrl.searchParams.toString()}`
  }

  // [P0-3] API 微缓存 De-noising (基于白名单构建 CacheKey)
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
        // [阶段1-P0] 使用 TTFB 超时+单次重试机制，避免长时间 0.0kb/s 挂起
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
            // [阶段2-P0] 空 tag 匿名图片短 TTL 缓存响应头
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
      // [阶段4-P1] DEBUG 采样控制 + 增强 Server-Timing 字段
      const shouldSample = Math.random() < CONFIG.DEBUG_SAMPLE_RATE
      if (shouldSample || (isVideo || hasRange)) {  // 媒体请求始终记录
        const clientClass = 'client'
        const playerClass = playerHint || 'na'
        const timing = [
          `kind;desc="${kind}"`,
          `client;desc="${clientClass}"`,
          `player_hint;desc="${playerClass}"`,
          `kv_read;dur=${kvReadMs}`,
          `cache_hit;desc="${cacheHit}"`,
          `upstream;dur=${upstreamMs}`,
          `retry;desc="${retryCount}"`,
          `subreq;desc="${subreqCount}"`
        ].join(', ');
        resHeaders.set('Server-Timing', timing);
        console.log(`[PERF] ${req.method} ${url.pathname} | Status: ${response.status} | ${timing}`);
      }
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

    // [优化-P0] 图片 5xx 降级：返回 1x1 透明 PNG，避免 UI 破损图标
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
    // [P1-1] 错误语义化：区分 Timeout (504) 与 Bad Gateway (502)
    const isTimeout = error.name === 'AbortError' || error.message === 'Timeout' || (error.code === 23); // 23 is Cloudflare-specific generic timeout code sometimes
    const status = isTimeout ? 504 : 502
    const statusText = isTimeout ? 'Gateway Timeout' : 'Bad Gateway'

    // [优化-P0] 增加诊断 Header：对于视频/Range 使用正确的 TTFB 超时值
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

export default app