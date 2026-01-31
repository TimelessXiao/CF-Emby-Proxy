export const MANAGE_UI_HTML = `<!DOCTYPE html>
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
      const bar = document.getElementById('bulkActionBar'); const countSpan = document.getElementById('selectedCount');
      if (selectedRoutes.size > 0) { bar.style.display = 'flex'; countSpan.textContent = \`已选择 \${selectedRoutes.size} 项\`; } else { bar.style.display = 'none'; }
    }
    async function batchDelete() {
      const targets = Array.from(selectedRoutes); if (targets.length === 0) return; if (!confirm(\`确定要删除选中的 \${targets.length} 个路由吗？\`)) return;
      try {
        const headers = { 'Content-Type': 'application/json' }; if (currentVersion) headers['If-Match'] = currentVersion;
        const result = await apiCall('/manage/api/batch-delete', { method: 'POST', headers, body: JSON.stringify({ subdomains: targets }) });
        showToast(\`成功删除 \${result.count} 个路由 (约60秒生效)\`); selectedRoutes.clear(); document.getElementById('bulkActionBar').style.display = 'none'; await loadRoutes();
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
