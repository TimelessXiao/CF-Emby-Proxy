import { Hono } from 'hono'

const CONFIG = {
  UPSTREAM_URL: 'https://your-emby-server.com', // Default upstream URL (can be overridden by env.UPSTREAM_URL)

  // [关键修复]
  // 1. 匹配带后缀的文件
  // 2. 匹配 Emby 特有的无后缀图片路径 (/Images/Primary, /Images/Backdrop 等)
  STATIC_REGEX: /(\.(jpg|jpeg|png|gif|css|js|ico|svg|webp|woff|woff2)|(\/Images\/(Primary|Backdrop|Logo|Thumb|Banner|Art)))/i,

  // 视频流 (直连，不缓存，不重试)
  VIDEO_REGEX: /(\/Videos\/|\/Items\/.*\/Download|\/Items\/.*\/Stream)/i,

  // [新增] 慢接口微缓存 (解决 Resume 1.5s 的问题)
  // 缓存 API 响应 5-10秒，大幅提升"返回/进入"页面的流畅度，同时不影响数据准确性
  API_CACHE_REGEX: /(\/Items\/Resume|\/Users\/.*\/Items\/)/i,

  // API超时设置
  API_TIMEOUT: 4500,
  CRITICAL_TIMEOUT: 9000,

  // Android TV/ExoPlayer 识别
  ANDROID_TV_UA: /(ExoPlayer|AFT|BRAVIA|MiTV|SHIELD|GoogleTV|FireTV|Chromecast|Android TV)/i,
  ANDROID_API_TIMEOUT: 6000,

  // 播放清单与播放信息微缓存
  M3U8_REGEX: /\.m3u8($|\?)/i,
  PLAYBACKINFO_REGEX: /\/PlaybackInfo/i,
  M3U8_TTL: 2,
  PLAYBACKINFO_TTL: 3,

  // 最大允许缓冲请求体大小（字节）
  MAX_BODY_BUFFER: 262144,

  // 路由表内存缓存 TTL（秒）
  ROUTE_CACHE_TTL: 60
}

const app = new Hono()

// --- Utility Functions ---
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

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

  let token = headers.get('X-Emby-Token') ||
              headers.get('X-MediaBrowser-Token') ||
              params.get('api_key') ||
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

  const tokenPart = token || 'anon'
  const devicePart = deviceId || 'nodev'
  return sha256Hex(`${tokenPart}:${devicePart}`)
}

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
//   修正F：当前调用策略下，此参数基本不会生效（WS请求侧不调用、101响应侧不调用）
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
      // KV optimization: use shorter TTL for empty state (10s vs 60s)
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
    // KV 读取失败时的降级策略
    if (cache.mappings) {
      // 保留过期缓存，继续服务（避免因 KV 短暂故障导致路由失效）
      console.warn('[KV Fallback] Using stale cache due to KV error:', error.message)
      return { version: cache.version, mappings: cache.mappings, kvReadMs }
    }
    // 如果没有任何缓存，返回空路由表并使用默认上游（保持可用性）
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

    /* 复选框样式 */
    input[type="checkbox"] { width: 18px; height: 18px; cursor: pointer; accent-color: #52B54B; }

    /* 批量操作栏 */
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

    /* 选中行高亮 */
    tr.selected { background: #252525 !important; border-left: 3px solid #52B54B; }

    @media (max-width: 768px) {
      /* 隐藏表头 */
      thead { display: none; }

      /* 卡片容器 */
      tr {
        display: block; background: #202020; border: 1px solid #333;
        border-radius: 8px; margin-bottom: 12px;
        padding: 16px 16px 16px 48px; position: relative;
      }

      /* 选中状态 */
      tr.selected { border-color: #52B54B; background: #252525; border-left: 3px solid #52B54B; }

      /* 复选框定位 */
      td:first-child { display: block; position: absolute; left: 12px; top: 16px; padding: 0; border: none; }

      /* 内容单元格 */
      td { display: block; padding: 4px 0; border: none; text-align: left; word-break: break-all; }

      /* 子域名样式 */
      td.col-sub { font-size: 16px; font-weight: bold; color: #fff; margin-bottom: 4px; }

      /* 上游地址样式 */
      td.col-upstream { font-size: 13px; color: #A0A0A0; margin-bottom: 12px; }

      /* 操作按钮区域 */
      td.col-actions {
        border-top: 1px solid #333; padding-top: 12px; margin-top: 8px;
        display: flex; justify-content: flex-end;
      }

      /* 按钮触摸目标 */
      .btn-sm { min-height: 44px; padding: 12px 16px; }

      /* 容器调整 */
      .container { padding: 10px; }

      /* 批量操作栏移动端优化 */
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

    // HTML 转义函数（防止 XSS 攻击）
    function escapeHtml(unsafe) {
      if (typeof unsafe !== 'string') return '';
      return unsafe
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#039;');
    }

    function showToast(message, isError = false) {
      const toast = document.getElementById('toast');
      toast.textContent = message;
      toast.className = isError ? 'error' : '';
      toast.style.display = 'block';
      setTimeout(() => toast.style.display = 'none', 3000);
    }

    async function apiCall(endpoint, options = {}) {
      if (!token) {
        token = prompt('请输入管理员令牌（ADMIN_TOKEN）：');
        if (!token) throw new Error('需要提供令牌');
      }
      const res = await fetch(endpoint, {
        ...options,
        headers: { ...options.headers, 'Authorization': 'Bearer ' + token }
      });
      if (res.status === 401) {
        token = '';
        throw new Error('令牌无效或未授权');
      }
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

        if (entries.length === 0) {
          tbody.innerHTML = '<tr><td colspan="4" style="text-align:center;color:#A0A0A0;">暂无路由配置</td></tr>';
        } else {
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
            </tr>
          \`;
          }).join('');
        }
        const displayVersion = currentVersion
          ? 'v' + new Date(parseInt(currentVersion.slice(1))).toISOString().slice(0,16).replace('T',' ')
          : '未初始化';
        document.getElementById('status').innerHTML = \`<small style="color:#A0A0A0;">版本：\${displayVersion} | 路由数：\${entries.length}</small>\`;
      } catch (e) {
        showToast('加载路由失败：' + e.message, true);
      }
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

        // 如果是编辑模式且子域名改变了，需要先删除旧路由
        if (editingSubdomain !== null && editingSubdomain !== sub) {
          const deleteResult = await apiCall(\`/manage/api/mappings/\${editingSubdomain}\`, {
            method: 'DELETE',
            headers: { 'If-Match': currentVersion }
          });
          // 更新版本号，避免后续 PUT 请求冲突
          if (deleteResult && deleteResult.version) {
            currentVersion = deleteResult.version;
            headers['If-Match'] = currentVersion;
          }
        }

        // 添加或更新路由
        await apiCall(\`/manage/api/mappings/\${sub}\`, {
          method: 'PUT',
          headers,
          body: JSON.stringify({ upstream })
        });

        showToast(editingSubdomain !== null ? '路由更新成功' : '路由新增成功');
        cancelEdit();
        await loadRoutes();
      } catch (e) {
        showToast('保存路由失败：' + e.message, true);
      } finally {
        form.classList.remove('loading');
      }
    }

    function editRoute(sub, upstream) {
      editingSubdomain = sub;
      document.getElementById('subdomain').value = sub;
      document.getElementById('upstream').value = upstream;
      document.getElementById('submitBtn').textContent = '更新路由';
      document.getElementById('cancelBtn').style.display = 'inline-block';
      document.getElementById('subdomain').focus();
    }

    function cancelEdit() {
      editingSubdomain = null;
      document.getElementById('addForm').reset();
      document.getElementById('submitBtn').textContent = '新增路由';
      document.getElementById('cancelBtn').style.display = 'none';
    }

    // 全选/取消全选
    function toggleSelectAll() {
      const master = document.getElementById('selectAll');
      const checks = document.querySelectorAll('.route-check');
      checks.forEach(c => {
        c.checked = master.checked;
        if (master.checked) {
          selectedRoutes.add(c.value);
        } else {
          selectedRoutes.delete(c.value);
        }
      });
      updateSelectionState();
    }

    // 更新选中状态
    function updateSelectionState() {
      const checks = document.querySelectorAll('.route-check');
      selectedRoutes.clear();

      checks.forEach(c => {
        if (c.checked) {
          selectedRoutes.add(c.value);
        }
        // 视觉高亮
        const tr = c.closest('tr');
        if (c.checked) {
          tr.classList.add('selected');
        } else {
          tr.classList.remove('selected');
        }
      });

      // 更新主复选框状态
      const master = document.getElementById('selectAll');
      master.checked = checks.length > 0 && selectedRoutes.size === checks.length;
      master.indeterminate = selectedRoutes.size > 0 && selectedRoutes.size < checks.length;

      // 更新批量操作栏
      const bar = document.getElementById('bulkActionBar');
      const countSpan = document.getElementById('selectedCount');
      if (selectedRoutes.size > 0) {
        bar.style.display = 'flex';
        countSpan.textContent = \`已选择 \${selectedRoutes.size} 项\`;
      } else {
        bar.style.display = 'none';
      }
    }

    // 批量删除
    async function batchDelete() {
      const targets = Array.from(selectedRoutes);
      if (targets.length === 0) return;

      if (!confirm(\`确定要删除选中的 \${targets.length} 个路由吗？\`)) return;

      try {
        const headers = { 'Content-Type': 'application/json' };
        if (currentVersion) headers['If-Match'] = currentVersion;

        const result = await apiCall('/manage/api/batch-delete', {
          method: 'POST',
          headers,
          body: JSON.stringify({ subdomains: targets })
        });

        showToast(\`成功删除 \${result.count} 个路由\`);
        selectedRoutes.clear();
        document.getElementById('bulkActionBar').style.display = 'none';
        await loadRoutes();
      } catch (e) {
        showToast('批量删除失败：' + e.message, true);
      }
    }

    async function deleteRoute(sub) {
      if (!confirm(\`确定要删除路由 "\${sub}" 吗？\`)) return;

      try {
        const headers = {};
        if (currentVersion) headers['If-Match'] = currentVersion;
        await apiCall(\`/manage/api/mappings/\${sub}\`, {
          method: 'DELETE',
          headers
        });
        showToast('路由删除成功');
        await loadRoutes();
      } catch (e) {
        showToast('删除路由失败：' + e.message, true);
      }
    }

    async function exportConfig() {
      try {
        const data = await apiCall('/manage/api/export');
        const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = \`emby-routes-\${Date.now()}.json\`;
        a.click();
        showToast('配置导出成功');
      } catch (e) {
        showToast('导出配置失败：' + e.message, true);
      }
    }

    function importConfig() {
      const input = document.createElement('input');
      input.type = 'file';
      input.accept = 'application/json';
      input.onchange = async (e) => {
        try {
          const file = e.target.files[0];
          const text = await file.text();
          const data = JSON.parse(text);

          const headers = { 'Content-Type': 'application/json' };
          if (currentVersion) headers['If-Match'] = currentVersion;
          await apiCall('/manage/api/import', {
            method: 'POST',
            headers,
            body: JSON.stringify({ mappings: data.mappings || data })
          });
          showToast('配置导入成功');
          await loadRoutes();
        } catch (e) {
          showToast('导入配置失败：' + e.message, true);
        }
      };
      input.click();
    }

    async function rollback() {
      if (!confirm('确定要回滚到上一个版本吗？')) return;

      try {
        await apiCall('/manage/api/rollback', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' }
        });
        showToast('回滚成功');
        await loadRoutes();
      } catch (e) {
        showToast('回滚失败：' + e.message, true);
      }
    }

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
    canBufferBody = clValid && cl <= CONFIG.MAX_BODY_BUFFER

    if (canBufferBody) {
      reqBody = await req.arrayBuffer()
      proxyHeaders.delete('content-length')
    } else {
      reqBody = req.body
    }
  }

  // --- 判别请求类型 ---
  const isStatic = CONFIG.STATIC_REGEX.test(url.pathname)
  const isVideo = CONFIG.VIDEO_REGEX.test(url.pathname)
  const isApiCacheable = CONFIG.API_CACHE_REGEX.test(url.pathname)
  const isWebSocket = (req.headers.get('Upgrade') || '').toLowerCase() === 'websocket'
  const isM3U8 = CONFIG.M3U8_REGEX.test(url.pathname)
  const isPlaybackInfo = CONFIG.PLAYBACKINFO_REGEX.test(url.pathname)
  const hasRange = !!req.headers.get('range')
  const isAndroidTV = CONFIG.ANDROID_TV_UA.test(req.headers.get('user-agent') || '')

  // RFC 7230: 清理 hop-by-hop 头（WebSocket除外）
  if (!isWebSocket) {
    cleanupHopByHopHeaders(proxyHeaders, false, true)
  }

  // Android TV：设置 keep-alive (skip for WebSocket to preserve Upgrade header)
  if (isAndroidTV && !isWebSocket) {
    proxyHeaders.set('Connection', 'keep-alive')
  }

  // CPU optimization: only compute hash when cache key needed (whitelisted paths)
  // For static resources, skip hash if no token hint (avoid wasting CPU on anonymous requests)
  const hasTokenHint = req.headers.has('X-Emby-Token') ||
                       req.headers.has('X-MediaBrowser-Token') ||
                       url.searchParams.has('api_key') ||
                       req.headers.has('Authorization') ||
                       req.headers.has('X-Emby-Authorization')

  const needsCacheKey = !isVideo && !hasRange && (isM3U8 || isPlaybackInfo || isApiCacheable || (isStatic && hasTokenHint))
  const tokenHash = needsCacheKey ? await buildTokenKey(req, url) : null

  // 检查是否有有效 token（防止匿名用户缓存泄露）
  // CPU optimization: cache 'anon:nodev' hash to avoid recalculation
  if (!globalThis[ANON_HASH_CACHE_KEY]) {
    globalThis[ANON_HASH_CACHE_KEY] = await sha256Hex('anon:nodev')
  }
  // Note: hasToken will be false when tokenHash is null (hash skipped for media/range/anonymous static)
  // This is intentional - requests without cache keys should not trigger caching logic
  const hasToken = tokenHash && tokenHash !== globalThis[ANON_HASH_CACHE_KEY]

  // --- Cloudflare 策略配置 ---
  const cfConfig = {
    // 1. 静态图片：强力缓存 1 年（仅对已认证用户，防止跨用户泄露）
    cacheEverything: isStatic && hasToken,
    cacheTtl: (isStatic && hasToken) ? 31536000 : 0,

    // 2. API 微缓存：缓存 10 秒 (解决 Resume 接口慢的问题)
    // 注意：只有 GET 请求才会生效 cacheTtl
    cacheTtlByStatus: isApiCacheable ? { "200-299": 10 } : null,

    // 3. 性能优化开关
    // 静态资源：开启有损压缩 (polish) 以加快图片传输
    // 视频资源：彻底关闭所有处理 (off)
    polish: isStatic ? 'lossy' : 'off',
    minify: { javascript: isStatic, css: isStatic, html: isStatic },

    // 4. 视频流核心：关闭缓冲
    mirage: false,
    scrapeShield: false,
    apps: false,
  }

  // 静态资源缓存键隔离（防止跨用户泄露）
  if (isStatic && hasToken) {
    const keyUrl = new URL(targetUrl)
    if (keyUrl.searchParams.sort) keyUrl.searchParams.sort()
    cfConfig.cacheKey = `${keyUrl.pathname}?${keyUrl.searchParams.toString()}::${tokenHash}`
  }

  // 如果是 API 微缓存，也需要开启 cacheEverything 才能生效
  if (isApiCacheable && hasToken) {
    cfConfig.cacheEverything = true
    // 缓存安全：token-aware cacheKey 防止跨用户泄露
    const keyUrl = new URL(targetUrl)
    if (keyUrl.searchParams.sort) keyUrl.searchParams.sort()
    cfConfig.cacheKey = `${keyUrl.pathname}?${keyUrl.searchParams.toString()}::${tokenHash}`
  }

  // m3u8 微缓存（仅 GET 且非 Range，且有 token）
  if (isM3U8 && req.method === 'GET' && !hasRange && hasToken) {
    cfConfig.cacheEverything = true
    cfConfig.cacheTtl = CONFIG.M3U8_TTL
    const keyUrl = new URL(targetUrl)
    if (keyUrl.searchParams.sort) keyUrl.searchParams.sort()
    cfConfig.cacheKey = `${keyUrl.pathname}?${keyUrl.searchParams.toString()}::${tokenHash}`
  }

  // Range 请求不参与缓存，确保按字节区间直连
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

  // DEBUG mode: performance metrics (enabled via env.DEBUG)
  const DEBUG = c.env?.DEBUG === 'true' || c.env?.DEBUG === '1'
  const kind = isVideo ? 'media' : (hasRange ? 'range' : (isM3U8 ? 'm3u8' : (isPlaybackInfo ? 'playbackinfo' : 'api')))
  let kvReadMs = routeKvMs || 0
  let upstreamMs = 0
  let retryCount = 0
  let subreqCount = 0
  let cacheHit = 0

  try {
    let response;

    // Android TV：设置 keep-alive (skip for WebSocket to preserve Upgrade header)
    if (isAndroidTV && !isWebSocket) {
      proxyHeaders.set('Connection', 'keep-alive')
    }

    // PlaybackInfo POST 微缓存（caches.default）
    if (isPlaybackInfo && req.method === 'POST' && !hasRange && canBufferBody) {
      const bodyHash = await sha256Hex(reqBody || '')
      // Stable cache key: manually sort query parameters
      const sortedParams = Array.from(url.searchParams.entries())
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([k, v]) => `${k}=${v}`)
        .join('&')
      const cacheKey = `https://cache.playbackinfo.local${url.pathname}?${sortedParams}&h=${tokenHash}&b=${bodyHash}`
      const cacheReq = new Request(cacheKey, { method: 'GET' })
      const cache = caches.default
      const cached = await cache.match(cacheReq)
      if (cached) {
        cacheHit = 1
        return new Response(cached.body, { status: cached.status, headers: cached.headers })
      }

      // Critical path: bounded timeout, no retry
      const t0 = Date.now()
      subreqCount++
      const upstreamResp = await fetchWithTimeout(targetUrl.toString(), fetchOptions, CONFIG.CRITICAL_TIMEOUT)
      upstreamMs += Date.now() - t0

      const resHeaders = new Headers(upstreamResp.headers)

      // 清理hop-by-hop头（PlaybackInfo不会是101响应）
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
      // 媒体请求处理分支
      if ((isVideo || hasRange) && !isWebSocket) {
        // Media/Range: direct passthrough (no timeout/retry)
        const t0 = Date.now()
        subreqCount++
        response = await fetch(targetUrl.toString(), fetchOptions)
        upstreamMs += Date.now() - t0
      } else if (isWebSocket || (req.method === 'POST' && !(isPlaybackInfo && !hasRange))) {
        // WebSocket or other POST: direct passthrough (no timeout)
        const t0 = Date.now()
        subreqCount++
        response = await fetch(targetUrl.toString(), fetchOptions)
        upstreamMs += Date.now() - t0
      } else {
        // 其他请求：区分关键路径和非关键路径
        const isCriticalPath = (isM3U8 && req.method === 'GET') || (isApiCacheable && req.method === 'GET') || (isPlaybackInfo && req.method === 'POST')

        if (isCriticalPath) {
          // Critical path: bounded timeout, no retry
          const t0 = Date.now()
          subreqCount++
          response = await fetchWithTimeout(targetUrl.toString(), fetchOptions, CONFIG.CRITICAL_TIMEOUT)
          upstreamMs += Date.now() - t0
        } else {
          // Non-critical: keep timeout, but no retry
          const timeout = isAndroidTV ? CONFIG.ANDROID_API_TIMEOUT : CONFIG.API_TIMEOUT
          const t0 = Date.now()
          subreqCount++
          response = await fetchWithTimeout(targetUrl.toString(), fetchOptions, timeout)
          upstreamMs += Date.now() - t0
        }
      }
    }




    // --- 响应处理 ---
    const resHeaders = new Headers(response.headers)

    // RFC 7230: 清理 hop-by-hop 头（101响应除外）
    if (response.status !== 101) {
      cleanupHopByHopHeaders(resHeaders, false, false)
    }

    resHeaders.delete('content-security-policy')
    resHeaders.delete('clear-site-data')
    resHeaders.set('access-control-allow-origin', '*')

    // Connection optimization: Android TV uses keep-alive, others allow reuse (no forced close)
    if (isVideo && isAndroidTV) {
      resHeaders.set('Connection', 'keep-alive')
      resHeaders.set('Keep-Alive', 'timeout=30, max=1000')
    }

    // m3u8 Cache-Control Strategy: Use private to prevent client-side/intermediate cache issues
    if (isM3U8 && response.ok) {
      resHeaders.set('Cache-Control', `private, max-age=${CONFIG.M3U8_TTL}`)
    }

    // [补充] 强制静态图片缓存命中（仅对已认证用户，防止跨用户泄露）
    // Emby 有时会返回 private 或 no-cache 头，导致 CF 即使配置了 cacheEverything 也不缓存
    // 我们强制覆盖这些头
    if (isStatic && response.status === 200) {
        if (hasToken) {
            // 已认证用户：启用长期缓存
            resHeaders.set('Cache-Control', 'public, max-age=31536000, immutable')
            resHeaders.delete('Pragma')
            resHeaders.delete('Expires')
        } else {
            // 匿名用户：禁用缓存，防止跨用户泄露
            resHeaders.set('Cache-Control', 'no-store, no-cache, must-revalidate')
            resHeaders.set('Pragma', 'no-cache')
            resHeaders.set('Expires', '0')
        }
    }

    // DEBUG: Server-Timing header
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
      // 将性能信息和请求路径一起打印到日志中
      console.log(`[PERF] ${req.method} ${url.pathname} | Status: ${response.status} | ${timing}`);
    }

    if (response.status === 101) {
      return new Response(null, { status: 101, webSocket: response.webSocket, headers: resHeaders })
    }

    // 修正重定向
    if ([301, 302, 303, 307, 308].includes(response.status)) {
        const location = resHeaders.get('location')
        if (location) {
             const locUrl = new URL(location, targetUrl.href) // 兼容相对路径
             if (locUrl.hostname === targetUrl.hostname) {
                 resHeaders.set('Location', locUrl.pathname + locUrl.search)
             }
        }
        return new Response(null, { status: response.status, headers: resHeaders })
    }

    return new Response(response.body, {
      status: response.status,
      headers: resHeaders
    })

  } catch (error) {
    return new Response(JSON.stringify({ error: `Proxy Error: ${error.message}` }), { status: 502 })
  }
})

export default app