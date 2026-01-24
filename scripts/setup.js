'use strict';
/**
 * CF-Emby-Proxy: 交互式本地环境设置
 * - Cloudflare 身份认证
 * - 安装 npm 依赖
 * - 创建/选择 KV namespaces
 * - 从模板生成 wrangler.json
 * - 设置 ADMIN_TOKEN 密钥
 * - 验证配置
 */

const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const cp = require('child_process');
const readline = require('readline');

const ROOT = process.cwd();
const EXAMPLE_CFG = path.join(ROOT, 'wrangler.json.example');
const REAL_CFG = path.join(ROOT, 'wrangler.json');

// Non-interactive mode detection
const isNonInteractive = () => {
  return process.env.CI === 'true' || process.env.SETUP_NONINTERACTIVE === '1';
};

// Color helpers (ANSI escape codes)
const colors = {
  reset: '\x1b[0m',
  bold: '\x1b[1m',
  red: '\x1b[31m',
  green: '\x1b[32m',
  yellow: '\x1b[33m',
  blue: '\x1b[34m',
  cyan: '\x1b[36m'
};

function colorize(text, color) {
  return `${color}${text}${colors.reset}`;
}

// Utility functions
function banner(msg) {
  const line = '-'.repeat(Math.max(12, msg.length + 4));
  console.log('\n' + colorize(line, colors.cyan + colors.bold));
  console.log(colorize(`  ${msg}`, colors.cyan + colors.bold));
  console.log(colorize(line, colors.cyan + colors.bold) + '\n');
}

function compareSemver(a, b) {
  const pa = String(a).split('.').map(n => parseInt(n, 10) || 0);
  const pb = String(b).split('.').map(n => parseInt(n, 10) || 0);
  for (let i = 0; i < 3; i++) {
    if (pa[i] > pb[i]) return 1;
    if (pa[i] < pb[i]) return -1;
  }
  return 0;
}

function fileExists(p) {
  try { fs.accessSync(p); return true; } catch { return false; }
}

function isWindows() {
  return process.platform === 'win32';
}

function cmdBin(name) {
  if (isWindows() && (name === 'npm' || name === 'npx')) {
    return name + '.cmd';
  }
  return name;
}

function spawnp(cmd, args, opts = {}) {
  const finalCmd = cmdBin(cmd);
  return new Promise((resolve) => {
    // Windows fix: enable shell for .cmd files
    const spawnOpts = { cwd: ROOT, shell: false, ...opts };
    if (isWindows() && !opts.shell) {
      spawnOpts.shell = true;
    }

    const child = cp.spawn(finalCmd, args, spawnOpts);
    let stdout = '';
    let stderr = '';
    if (child.stdout) child.stdout.on('data', d => { stdout += d.toString(); });
    if (child.stderr) child.stderr.on('data', d => { stderr += d.toString(); });

    // Handle spawn errors (e.g., command not found)
    child.on('error', (err) => {
      resolve({ code: 1, stdout, stderr: `进程启动失败: ${err.message}` });
    });

    child.on('close', (code) => resolve({ code, stdout, stderr }));
  });
}

async function runOrThrow(cmd, args, opts = {}) {
  const { code, stdout, stderr } = await spawnp(cmd, args, opts);
  if (code !== 0) {
    const msg = `Command failed: ${cmd} ${args.join(' ')} (exit ${code})`;
    throw new Error(`${msg}\n${stderr || stdout || ''}`);
  }
  return { stdout, stderr };
}

function rlInterface() {
  return readline.createInterface({ input: process.stdin, output: process.stdout });
}

function ask(rl, q) {
  return new Promise((resolve) => rl.question(q, (ans) => resolve(ans)));
}

async function askYN(rl, q, def = true) {
  if (isNonInteractive()) {
    console.log(colorize(`[非交互模式] ${q} 使用默认值: ${def ? 'Y' : 'N'}`, colors.yellow));
    return def;
  }
  const suffix = def ? ' [Y/n] ' : ' [y/N] ';
  const ans = (await ask(rl, q + suffix)).trim().toLowerCase();
  if (!ans) return !!def;
  if (['y', 'yes'].includes(ans)) return true;
  if (['n', 'no'].includes(ans)) return false;
  return askYN(rl, q, def);
}

async function askChoice(rl, q, choices, defIdx = 0) {
  if (isNonInteractive()) {
    console.log(colorize(`[非交互模式] ${q} 使用默认值: ${choices[defIdx]}`, colors.yellow));
    return defIdx;
  }
  const msg = `${q}\n${choices.map((c, i) => `  ${i + 1}) ${c}`).join('\n')}\nChoose [${defIdx + 1}]: `;
  const ans = (await ask(rl, msg)).trim();
  if (!ans) return defIdx;
  const i = parseInt(ans, 10);
  if (i >= 1 && i <= choices.length) return i - 1;
  return askChoice(rl, q, choices, defIdx);
}

// Setup flow functions
async function ensureNode() {
  const cur = process.versions.node;
  const req = '18.0.0';
  if (compareSemver(cur, req) < 0) {
    throw new Error(`需要 Node.js ${req} 或更高版本。当前版本: ${cur}`);
  }
}

async function ensureDeps(rl) {
  banner('安装依赖');
  console.log('项目运行需要安装必要的 npm 依赖包 (如 wrangler, hono 等)。');
  const hasLock = fileExists(path.join(ROOT, 'package-lock.json'));
  const choice = await askChoice(rl, '现在安装依赖吗？', ['是（推荐）', '跳过（我已经安装过了）'], 0);
  if (choice === 1) {
    console.log(colorize('按您的要求跳过 npm install。', colors.yellow));
    return;
  }

  // Pause readline to prevent input conflicts
  rl.pause();
  try {
    // Try npm ci first if lockfile exists
    if (hasLock) {
      console.log('> npm ci');
      const { code, stderr } = await spawnp('npm', ['ci'], { stdio: 'inherit' });
      if (code !== 0) {
        console.log(colorize('\nnpm ci 失败（可能是 lockfile 不匹配）。尝试 npm install...', colors.yellow));
        console.log('> npm install');
        await runOrThrow('npm', ['install'], { stdio: 'inherit' });
      }
    } else {
      console.log('> npm install');
      await runOrThrow('npm', ['install'], { stdio: 'inherit' });
    }
  } finally {
    rl.resume();
  }
}

async function wranglerWhoAmI(rl) {
  if (rl) rl.pause();
  try {
    const { code } = await spawnp('npx', ['-y', 'wrangler', 'whoami'], { stdio: 'inherit' });
    return code === 0;
  } finally {
    if (rl) rl.resume();
  }
}

async function authFlow(rl) {
  banner('Cloudflare 身份认证');
  console.log('我们需要验证您的 Cloudflare 身份以管理 Workers 和 KV Storage。');

  // Non-interactive mode: use API token from environment
  if (isNonInteractive()) {
    const apiToken = process.env.CLOUDFLARE_API_TOKEN;
    if (apiToken) {
      console.log(colorize('[非交互模式] 使用环境变量 CLOUDFLARE_API_TOKEN', colors.yellow));
      const { code } = await spawnp('npx', ['-y', 'wrangler', 'config', '--api-token', apiToken], { stdio: 'inherit' });
      if (code !== 0) throw new Error('wrangler config --api-token 失败。');
    } else {
      console.log(colorize('[非交互模式] 跳过认证（假设已认证或使用现有凭证）', colors.yellow));
    }
    return;
  }

  const already = await wranglerWhoAmI(rl);
  if (already) {
    const cont = await askYN(rl, '已经登录。是否重新认证？', false);
    if (!cont) return;
  }
  const idx = await askChoice(rl, '选择认证方式：', ['浏览器登录 (wrangler login)', 'API 令牌 (wrangler config --api-token)'], 0);

  rl.pause();
  try {
    if (idx === 0) {
      console.log('> npx -y wrangler login');
      const { code } = await spawnp('npx', ['-y', 'wrangler', 'login'], { stdio: 'inherit' });
      if (code !== 0) throw new Error('wrangler login 失败。');
    } else {
      console.log('> npx -y wrangler config --api-token');
      const { code } = await spawnp('npx', ['-y', 'wrangler', 'config', '--api-token'], { stdio: 'inherit' });
      if (code !== 0) throw new Error('wrangler config --api-token 失败。');
    }
  } finally {
    rl.resume();
  }

  const ok = await wranglerWhoAmI(rl);
  if (!ok) throw new Error('身份认证验证失败。');
}

function isHex32(s) {
  return /^[a-f0-9]{32}$/i.test(String(s || '').trim());
}

async function createKvNamespace(title) {
  const args = ['-y', 'wrangler', 'kv', 'namespace', 'create', title];
  let result;
  try {
    result = await runOrThrow('npx', args, { stdio: ['ignore', 'pipe', 'pipe'] });
  } catch (e) {
    if (e.message.includes('permission') || e.message.includes('unauthorized') || e.message.includes('forbidden')) {
      throw new Error(`创建 KV namespace "${title}" 失败。请检查您的 API 令牌权限（需要 Workers KV 写入权限）。`);
    }
    throw e;
  }

  const { stdout, stderr } = result;
  const output = stdout + '\n' + stderr;

  try {
    const j = JSON.parse(stdout.trim());
    if (j && j.id) return j.id;
  } catch (e) {
    // Ignore JSON parse error, fall back to regex
  }

  const m = output.match(/"id"\s*:\s*"([a-f0-9]{32})"/i) ||
            output.match(/id:\s*([a-f0-9]{32})/i) ||
            output.match(/\s+([a-f0-9]{32})\s+/);

  if (m) return m[1];
  throw new Error(`无法解析 KV namespace id（"${title}"）。输出：\n${output}`);
}

async function kvFlow(rl) {
  banner('KV Namespace (ROUTE_MAP) 设置');
  console.log('KV Namespace 用于存储路由映射规则。');

  // Non-interactive mode: use KV IDs from environment
  if (isNonInteractive()) {
    const id = process.env.KV_NAMESPACE_ID;
    const preview_id = process.env.KV_PREVIEW_ID;

    if (!id) {
      throw new Error('非交互模式需要环境变量 KV_NAMESPACE_ID');
    }

    if (!isHex32(id)) {
      throw new Error(`无效的 KV ID 格式: ${id}。需要 32 位十六进制字符串。`);
    }

    if (preview_id) {
      if (!isHex32(preview_id)) {
        throw new Error(`无效的 KV_PREVIEW_ID 格式: ${preview_id}。需要 32 位十六进制字符串。`);
      }
      console.log(colorize(`[非交互模式] 使用独立的预览环境 KV ID`, colors.yellow));
      console.log(`  - 生产环境: ${id}`);
      console.log(`  - 预览环境: ${preview_id}`);
      return { id, preview_id };
    }

    console.log(colorize(`[非交互模式] 使用 KV Namespace ID: ${id}`, colors.yellow));
    console.log(colorize(`  提示: 预览环境将使用相同的 KV（如需独立，请设置 KV_PREVIEW_ID）`, colors.yellow));
    return { id, preview_id: id };
  }

  const useExisting = await askYN(rl, '使用现有的 KV namespace ID？', false);
  if (useExisting) {
    console.log(colorize('\n提示：KV Namespace ID 是一个 32 位的十六进制字符串。', colors.cyan));
    console.log(colorize('您可以在 Cloudflare Dashboard > Workers & Pages > KV 中找到它。', colors.cyan));
    console.log(colorize('或者运行命令：npx wrangler kv namespace list', colors.cyan));
    console.log(colorize('示例 ID：067e56067e56067e56067e56067e5606', colors.cyan) + '\n');

    let id = '';
    while (!isHex32(id)) {
      id = (await ask(rl, '输入生产环境 KV ID (32位 hex): ')).trim();
      if (!id) continue;
      if (!isHex32(id)) {
        console.error(colorize('错误：无效的 ID 格式。请输入 32 位十六进制字符串。', colors.red));
        id = ''; // Reset to ensure loop continues
      }
    }

    let previewId = (await ask(rl, '输入预览环境 KV ID (可选，回车跳过): ')).trim();
    if (previewId && !isHex32(previewId)) {
      console.warn(colorize('警告：预览环境 ID 格式无效，将忽略该输入并使用生产环境 ID。', colors.yellow));
      previewId = '';
    }

    if (!previewId) {
      console.log(colorize('\n注意：预览环境将使用相同的 KV Namespace。', colors.yellow));
      console.log(colorize('这意味着预览部署的写操作会影响生产数据。', colors.yellow));
      const confirm = await askYN(rl, '确认使用相同的 KV？', true);
      if (!confirm) {
        console.log(colorize('已取消。请重新运行脚本并提供独立的预览环境 KV ID。', colors.red));
        throw new Error('用户取消操作。');
      }
      previewId = id;
    }

    return { id, preview_id: previewId };
  }
  console.log('脚本将创建一个 KV Namespace 用于生产环境。');
  console.log(colorize('提示：预览环境将使用相同的 KV（适用于只读或测试场景）。', colors.cyan));
  const base = (await ask(rl, 'Namespace 标题 [cf-emby-proxy-ROUTE_MAP]: ')).trim() || 'cf-emby-proxy-ROUTE_MAP';
  console.log(`正在创建 KV namespace: "${base}"...`);

  let id;
  try {
    id = await createKvNamespace(base);
  } catch (e) {
    throw e;
  }

  console.log(colorize(`创建成功: ${id}`, colors.green));
  console.log(colorize('预览环境将使用相同的 KV Namespace。', colors.yellow));
  return { id, preview_id: id };
}

async function generateWranglerJson(ids, rl) {
  banner('从模板生成 wrangler.json');
  if (!fileExists(EXAMPLE_CFG)) {
    throw new Error('找不到 wrangler.json.example。');
  }

  // Check if wrangler.json already exists
  if (fileExists(REAL_CFG)) {
    const choice = await askChoice(rl, 'wrangler.json 已存在。您想要：',
      ['覆盖', '备份后覆盖', '中止'], 2);
    if (choice === 2) {
      throw new Error('用户中止设置。');
    }
    if (choice === 1) {
      const backupPath = REAL_CFG + '.bak';
      await fsp.copyFile(REAL_CFG, backupPath);
      console.log(colorize(`已备份现有配置到 ${path.relative(ROOT, backupPath)}`, colors.green));
    }
  }

  const raw = await fsp.readFile(EXAMPLE_CFG, 'utf8');
  const cfg = JSON.parse(raw);
  cfg.kv_namespaces = [{ binding: 'ROUTE_MAP', id: ids.id, preview_id: ids.preview_id }];
  await fsp.writeFile(REAL_CFG, JSON.stringify(cfg, null, 2) + '\n', 'utf8');
  console.log(colorize(`已写入 ${path.relative(ROOT, REAL_CFG)}（已被 git 忽略）`, colors.green));
}

async function setAdminSecret(rl) {
  banner('ADMIN_TOKEN 密钥设置');
  console.log('ADMIN_TOKEN 用于保护管理 API 接口，防止未授权访问。');

  // Non-interactive mode: use ADMIN_TOKEN from environment
  if (isNonInteractive()) {
    const adminToken = process.env.ADMIN_TOKEN;
    if (!adminToken) {
      console.log(colorize('[非交互模式] 跳过 ADMIN_TOKEN 设置（环境变量未提供）', colors.yellow));
      return;
    }

    console.log(colorize('[非交互模式] 使用环境变量 ADMIN_TOKEN', colors.yellow));
    console.log('> npx -y wrangler secret put ADMIN_TOKEN --config wrangler.json');

    // Use stdin to pass token securely (avoid shell interpolation)
    const proc = cp.spawn(cmdBin('npx'), ['-y', 'wrangler', 'secret', 'put', 'ADMIN_TOKEN', '--config', 'wrangler.json'], {
      cwd: ROOT,
      stdio: ['pipe', 'inherit', 'inherit'],
      shell: isWindows() // Windows needs shell for .cmd files
    });

    proc.stdin.write(adminToken + '\n');
    proc.stdin.end();

    const code = await new Promise((resolve) => {
      proc.on('close', resolve);
      proc.on('error', () => resolve(1));
    });

    if (code !== 0) throw new Error('设置 ADMIN_TOKEN 密钥失败。');
    return;
  }

  const doSecret = await askYN(rl, '现在设置 ADMIN_TOKEN 密钥吗？', true);
  if (!doSecret) return;
  console.log('> npx -y wrangler secret put ADMIN_TOKEN --config wrangler.json');

  rl.pause();
  try {
    const { code } = await spawnp('npx', ['-y', 'wrangler', 'secret', 'put', 'ADMIN_TOKEN', '--config', 'wrangler.json'], { stdio: 'inherit' });
    if (code !== 0) throw new Error('设置 ADMIN_TOKEN 密钥失败。');
  } finally {
    rl.resume();
  }
}

async function validateSetup(rl) {
  banner('验证配置');
  const ok = await wranglerWhoAmI(rl);
  if (!ok) throw new Error('设置后 whoami 验证失败。');

  rl.pause();
  try {
    const { stdout, stderr } = await runOrThrow('npx', ['-y', 'wrangler', 'kv', 'namespace', 'list'], { stdio: ['ignore', 'pipe', 'pipe'] });
    const output = stdout + '\n' + stderr;

    try {
      const arr = JSON.parse(stdout);
      console.log(colorize(`在账户中找到 ${arr.length} 个 KV namespaces。`, colors.green));
    } catch (e) {
      const lines = output.split('\n').filter(l => l.trim());
      const count = lines.filter(l => /[a-f0-9]{32}/i.test(l)).length;
      if (count > 0) {
        console.log(colorize(`在账户中找到 ${count} 个 KV namespaces。`, colors.green));
      } else {
        console.warn(colorize('无法解析 KV 列表，但命令执行成功。', colors.yellow));
      }
    }
  } finally {
    rl.resume();
  }

  console.log(colorize('\n验证完成。您现在可以运行：\n', colors.green));
  console.log('  npm run dev     # 本地运行');
  console.log('  npm run deploy  # 部署到 Cloudflare\n');
}

async function ensureGitignoreHasWrangler() {
  const giPath = path.join(ROOT, '.gitignore');
  if (!fileExists(giPath)) return;
  const content = await fsp.readFile(giPath, 'utf8');
  if (!content.split(/\r?\n/).some(line => line.trim() === 'wrangler.json')) {
    console.log('正在将 wrangler.json 添加到 .gitignore...');
    await fsp.appendFile(giPath, '\nwrangler.json\n', 'utf8');
    console.log(colorize('✓ wrangler.json 已添加到 .gitignore', colors.green));
  }
}

async function main() {
  banner('CF-Emby-Proxy 本地环境设置');
  await ensureNode();
  const rl = rlInterface();
  try {
    await ensureDeps(rl);
    await authFlow(rl);
    const ids = await kvFlow(rl);
    await generateWranglerJson(ids, rl);
    await ensureGitignoreHasWrangler();
    await setAdminSecret(rl);
    await validateSetup(rl);
    banner('设置完成');
  } catch (e) {
    console.error(colorize('\n设置失败:', colors.red), e.message);
    process.exitCode = 1;
  } finally {
    rl.close();
  }
}

main().catch((e) => {
  console.error('致命错误:', e);
  process.exit(1);
});
