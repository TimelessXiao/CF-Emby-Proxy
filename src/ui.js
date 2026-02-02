export const MANAGE_UI_HTML = `<!DOCTYPE html>
<html lang="zh-CN">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>CF Emby 代理管理器</title>
  <style>
    :root {
      --c-primary: #52B54B;
      --c-primary-hover: #45a03e;
      --c-primary-glow: rgba(82,181,75,0.25);
      --c-danger: #ef4444;
      --c-danger-glow: rgba(239,68,68,0.2);
      --c-bg: #0a0e14;
      --c-surface: rgba(15,23,35,0.8);
      --c-card: rgba(20,30,45,0.65);
      --c-border: rgba(82,181,75,0.12);
      --c-border-subtle: rgba(255,255,255,0.06);
      --c-text: #f1f5f9;
      --c-muted: #94a3b8;
      --radius: 16px;
      --radius-sm: 10px;
      --shadow: 0 4px 24px rgba(0,0,0,0.4);
      --transition: 0.2s cubic-bezier(0.4,0,0.2,1);
    }
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body { font-family: system-ui, -apple-system, BlinkMacSystemFont, sans-serif; background: linear-gradient(145deg, #0a0e14 0%, #0d1520 50%, #0a0e14 100%); color: var(--c-text); padding: 40px 24px; min-height: 100vh; }
    .container { max-width: 960px; margin: 0 auto; }
    h1 { color: var(--c-primary); margin-bottom: 6px; font-size: 1.625rem; font-weight: 600; text-shadow: 0 0 20px var(--c-primary-glow); }
    .subtitle { color: var(--c-muted); margin-bottom: 32px; font-size: 13px; letter-spacing: 0.3px; }
    .card { background: var(--c-card); backdrop-filter: blur(16px); -webkit-backdrop-filter: blur(16px); border: 1px solid var(--c-border); border-radius: var(--radius); padding: 24px; margin-bottom: 20px; box-shadow: var(--shadow), inset 0 1px 0 rgba(255,255,255,0.04); }
    .card h2 { color: #fff; margin-bottom: 20px; font-size: 0.9375rem; font-weight: 500; padding-bottom: 14px; border-bottom: 1px solid var(--c-border-subtle); }
    .card-header { display: flex; align-items: center; justify-content: space-between; margin-bottom: 20px; padding-bottom: 14px; border-bottom: 1px solid var(--c-border-subtle); min-height: 24px; }
    .card-header h2 { margin: 0; padding: 0; border: none; }
    .bulk-actions { display: flex; align-items: center; gap: 12px; }
    .bulk-actions span { color: var(--c-muted); font-size: 12px; white-space: nowrap; }
    .bulk-actions .btn-sm { padding: 6px 14px; min-height: auto; }
    .form-group { margin-bottom: 18px; }
    label { display: block; margin-bottom: 8px; font-size: 12px; color: var(--c-muted); font-weight: 500; letter-spacing: 0.3px; }
    input, textarea { width: 100%; padding: 12px 16px; background: rgba(0,0,0,0.35); border: 1px solid var(--c-border-subtle); border-radius: var(--radius-sm); color: #fff; font-size: 14px; transition: var(--transition); }
    input:focus, textarea:focus { outline: none; border-color: var(--c-primary); box-shadow: 0 0 0 3px var(--c-primary-glow), inset 0 1px 2px rgba(0,0,0,0.2); }
    button { padding: 11px 22px; background: var(--c-primary); color: #0a0e14; border: none; border-radius: var(--radius-sm); cursor: pointer; font-size: 13px; font-weight: 600; transition: var(--transition); }
    button:hover { background: var(--c-primary-hover); box-shadow: 0 0 20px var(--c-primary-glow); }
    button:active { transform: scale(0.98); }
    button.secondary { background: rgba(255,255,255,0.05); color: var(--c-text); border: 1px solid var(--c-border-subtle); }
    button.secondary:hover { background: rgba(255,255,255,0.1); border-color: var(--c-border); }
    button.danger { background: rgba(239,68,68,0.1); color: var(--c-danger); border: 1px solid rgba(239,68,68,0.2); }
    button.danger:hover { background: var(--c-danger); color: #fff; box-shadow: 0 0 20px var(--c-danger-glow); }
    .actions { display: flex; gap: 10px; flex-wrap: wrap; }
    table { width: 100%; border-collapse: collapse; }
    th, td { text-align: left; padding: 14px 12px; border-bottom: 1px solid var(--c-border-subtle); }
    th { color: var(--c-muted); font-weight: 500; font-size: 11px; text-transform: uppercase; letter-spacing: 0.8px; }
    td { color: var(--c-text); transition: var(--transition); }
    tbody tr { transition: var(--transition); }
    tbody tr:hover { background: rgba(82,181,75,0.04); }
    tbody tr:hover td { border-color: var(--c-border); }
    .btn-group { display: flex; gap: 8px; }
    .btn-sm { padding: 7px 14px; font-size: 12px; border-radius: 8px; }
    #toast { position: fixed; top: 24px; right: 24px; background: var(--c-surface); backdrop-filter: blur(16px); border: 1px solid var(--c-border); border-left: 3px solid var(--c-primary); color: #fff; padding: 14px 20px; border-radius: var(--radius-sm); display: none; box-shadow: var(--shadow); z-index: 1000; animation: slideIn 0.3s cubic-bezier(0.4,0,0.2,1); }
    #toast.error { border-left-color: var(--c-danger); }
    @keyframes slideIn { from { opacity: 0; transform: translateX(20px); } to { opacity: 1; transform: translateX(0); } }
    .loading { opacity: 0.5; pointer-events: none; }
    input[type="checkbox"] { width: 18px; height: 18px; cursor: pointer; accent-color: var(--c-primary); }
    tr.selected { background: rgba(82,181,75,0.06); }
    tr.selected td { border-color: var(--c-border); }
    @media (max-width: 768px) {
      body { padding: 24px 16px; }
      .container { max-width: 100%; }
      h1 { font-size: 1.375rem; }
      .card { padding: 20px; border-radius: 14px; }
      .actions { flex-direction: column; }
      .actions button { width: 100%; justify-content: center; }
      thead { display: none; }
      tbody tr { display: block; background: rgba(0,0,0,0.25); border: 1px solid var(--c-border-subtle); border-radius: 14px; margin-bottom: 12px; padding: 16px 16px 16px 48px; position: relative; }
      tr.selected { border-color: var(--c-primary); background: rgba(82,181,75,0.06); }
      td:first-child { position: absolute; left: 16px; top: 18px; padding: 0; border: none; }
      td { display: block; padding: 3px 0; border: none; word-break: break-all; }
      td.col-sub { font-size: 15px; font-weight: 600; color: #fff; margin-bottom: 2px; }
      td.col-upstream { font-size: 12px; color: var(--c-muted); margin-bottom: 14px; font-family: ui-monospace, monospace; }
      td.col-actions { border-top: 1px solid var(--c-border-subtle); padding-top: 14px; margin-top: 8px; display: flex; justify-content: flex-end; }
      .btn-sm { min-height: 44px; padding: 12px 18px; }
    }
    @media (prefers-reduced-motion: reduce) { *, *::before, *::after { animation-duration: 0.01ms !important; transition-duration: 0.01ms !important; } }
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
      <div class="card-header">
        <h2>已配置的路由</h2>
        <div id="bulkActions" class="bulk-actions" style="display:none;">
          <span id="selectedCount">已选择 0 项</span>
          <button onclick="batchDelete()" class="btn-sm danger">删除选中</button>
        </div>
      </div>
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

  <div id="toast" role="alert" aria-live="polite" aria-atomic="true"></div>

  <script>
    let token = '';
    let currentVersion = null;
    let editingSubdomain = null;
    let selectedRoutes = new Set();
    function escapeHtml(unsafe) { if (typeof unsafe !== 'string') return ''; return unsafe.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#039;'); }
    function showToast(message, isError = false) { const toast = document.getElementById('toast'); toast.textContent = message; toast.className = isError ? 'error' : ''; toast.style.display = 'block'; setTimeout(() => toast.style.display = 'none', 4000); }
    function formatShanghaiTime(timestamp, includeSeconds = false) {
      try {
        const date = new Date(timestamp);
        if (isNaN(date.getTime())) return null;
        const parts = new Intl.DateTimeFormat('en-US', {
          timeZone: 'Asia/Shanghai',
          year: 'numeric',
          month: '2-digit',
          day: '2-digit',
          hour: '2-digit',
          minute: '2-digit',
          second: includeSeconds ? '2-digit' : undefined,
          hour12: false
        }).formatToParts(date);
        const get = (type) => parts.find(p => p.type === type)?.value || '00';
        if (includeSeconds) {
          return \`\${get('year')}-\${get('month')}-\${get('day')}T\${get('hour')}:\${get('minute')}:\${get('second')}+08:00\`;
        }
        return \`\${get('year')}-\${get('month')}-\${get('day')} \${get('hour')}:\${get('minute')}\`;
      } catch (e) {
        return null;
      }
    }
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
            const upstreamStr = typeof config.upstream === 'string' ? config.upstream : '';
            const escapedUpstream = escapeHtml(upstreamStr);
            const jsEscapedSub = JSON.stringify(sub).slice(1, -1);
            const jsEscapedUpstream = JSON.stringify(upstreamStr).slice(1, -1);
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
        const displayVersion = currentVersion ? (() => {
          if (!/^v\\d+$/.test(currentVersion)) return '未知版本';
          const timestamp = parseInt(currentVersion.slice(1));
          const formatted = formatShanghaiTime(timestamp, false);
          return formatted ? 'v' + formatted : '未知版本';
        })() : '未初始化';
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
          const deleteResult = await apiCall(\`/manage/api/mappings/\${encodeURIComponent(editingSubdomain)}\`, { method: 'DELETE', headers: { 'If-Match': currentVersion } });
          if (deleteResult && deleteResult.version) { currentVersion = deleteResult.version; headers['If-Match'] = currentVersion; }
        }
        await apiCall(\`/manage/api/mappings/\${encodeURIComponent(sub)}\`, { method: 'PUT', headers, body: JSON.stringify({ upstream }) });
        showToast((editingSubdomain !== null ? '路由更新成功' : '路由新增成功') + ' (约60秒生效)');
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
      const bulk = document.getElementById('bulkActions'); const countSpan = document.getElementById('selectedCount');
      if (selectedRoutes.size > 0) { bulk.style.display = 'flex'; countSpan.textContent = \`已选择 \${selectedRoutes.size} 项\`; } else { bulk.style.display = 'none'; }
    }
    async function batchDelete() {
      const targets = Array.from(selectedRoutes); if (targets.length === 0) return; if (!confirm(\`确定要删除选中的 \${targets.length} 个路由吗？\`)) return;
      try {
        const headers = { 'Content-Type': 'application/json' }; if (currentVersion) headers['If-Match'] = currentVersion;
        const result = await apiCall('/manage/api/batch-delete', { method: 'POST', headers, body: JSON.stringify({ subdomains: targets }) });
        showToast(\`成功删除 \${result.count} 个路由 (约60秒生效)\`); selectedRoutes.clear(); document.getElementById('bulkActions').style.display = 'none'; await loadRoutes();
      } catch (e) { showToast('批量删除失败：' + e.message, true); }
    }
    async function deleteRoute(sub) { if (!confirm(\`确定要删除路由 "\${sub}" 吗？\`)) return; try { const headers = {}; if (currentVersion) headers['If-Match'] = currentVersion; await apiCall(\`/manage/api/mappings/\${encodeURIComponent(sub)}\`, { method: 'DELETE', headers }); showToast('路由删除成功 (约60秒生效)'); await loadRoutes(); } catch (e) { showToast('删除路由失败：' + e.message, true); } }
    async function exportConfig() { try { const data = await apiCall('/manage/api/export'); const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' }); const url = URL.createObjectURL(blob); const a = document.createElement('a'); a.href = url; a.download = \`emby-routes-\${Date.now()}.json\`; a.click(); showToast('配置导出成功'); } catch (e) { showToast('导出配置失败：' + e.message, true); } }
    function importConfig() {
      const input = document.createElement('input'); input.type = 'file'; input.accept = 'application/json';
      input.onchange = async (e) => { try { const file = e.target.files[0]; const text = await file.text(); const data = JSON.parse(text); const headers = { 'Content-Type': 'application/json' }; if (currentVersion) headers['If-Match'] = currentVersion; await apiCall('/manage/api/import', { method: 'POST', headers, body: JSON.stringify({ mappings: data.mappings || data }) }); showToast('配置导入成功 (约60秒生效)'); await loadRoutes(); } catch (e) { showToast('导入配置失败：' + e.message, true); } }; input.click();
    }
    async function rollback() { if (!confirm('确定要回滚到上一个版本吗？')) return; try { await apiCall('/manage/api/rollback', { method: 'POST', headers: { 'Content-Type': 'application/json' } }); showToast('回滚成功 (约60秒生效)'); await loadRoutes(); } catch (e) { showToast('回滚失败：' + e.message, true); } }
    loadRoutes();
  </script>
</body>
</html>`;
