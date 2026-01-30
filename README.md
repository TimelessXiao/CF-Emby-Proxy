# CF-Emby-Proxy

<div align="center">

**基于 Cloudflare Workers 的 Emby 媒体服务器智能加速代理**

[![License: ISC](https://img.shields.io/badge/License-ISC-blue.svg)](https://opensource.org/licenses/ISC)
[![Cloudflare Workers](https://img.shields.io/badge/Cloudflare-Workers-F38020?logo=cloudflare)](https://workers.cloudflare.com/)
[![Node.js](https://img.shields.io/badge/Node.js-%3E%3D18-339933?logo=node.js)](https://nodejs.org/)

利用 Cloudflare 全球边缘网络加速 Emby 访问，智能缓存策略显著提升用户体验

[功能特性](#-功能特性) • [快速开始](#-快速开始) • [配置说明](#-配置说明) • [缓存策略](#-缓存策略) • [路由管理](#-动态路由管理)

</div>

---

## 📌 项目亮点

- 🚀 **三级缓存优化**：PlaybackInfo POST 缓存、API 边缘缓存、匿名图片缓存全面加速
- 🌍 **动态路由**：多 Emby 服务器动态切换，支持子域名映射（`*.yourdomain.com`）
- 📱 **Android TV 优化**：针对 ExoPlayer 客户端专项优化，改善起播速度
- 🔐 **安全隔离**：Token 级缓存键隔离，防止跨用户数据泄露
- ⚡ **智能降级**：Cloudflare Workers Free Plan 优化，内存/CPU 受限环境下稳定运行
- 🛠️ **一键部署**：交互式自动化脚本，从零到部署只需 3 分钟

---

## ✨ 功能特性

### 核心功能

#### 🎯 智能缓存系统

**1. PlaybackInfo POST 缓存（新增）**
- 支持无 Content-Length 头的 chunked 请求缓存
- 64KB 硬限制增量缓冲，防止 Free Plan 资源耗尽
- 解决 TV/App 端 7+ 秒起播延迟问题

**2. API 边缘缓存强制（新增）**
- 覆盖源站 `Cache-Control: private/no-store` 限制
- 白名单端点：Resume, Latest, Views, NextUp
- 10 秒边缘缓存 + `max-age=0` 防止浏览器陈旧数据
- 解决频繁刷新库 5-6 秒回源延迟

**3. Tag 图片匿名缓存（新增）**
- `/Items/{id}/Images/*?tag=xxx` 公共缓存
- 内容指纹（tag）保证不可变性
- 严格隐私保护：排除 `/Users/` 和 `/Persons/`
- 解决首屏加载 3+ 秒图片回源压力

**4. 传统缓存策略**
- 静态资源（图片/CSS/JS）：1 年长期缓存
- 视频流：直连透传，不缓存
- WebSocket：完整支持，实时通信

#### 🌐 动态路由管理

- **多服务器支持**：基于子域名自动切换上游服务器
- **热更新**：通过 Web 管理界面实时修改路由，无需重新部署
- **KV 存储**：路由配置存储在 Cloudflare KV，全球同步
- **管理界面**：访问 `/manage` 进行可视化路由管理

**使用场景**：
- `emby1.yourdomain.com` → 服务器 A
- `emby2.yourdomain.com` → 服务器 B
- `default` → 默认服务器

#### 📱 Android TV 专项优化

- ExoPlayer 客户端识别
- Keep-Alive 连接复用
- 专用 API 超时策略（6 秒）
- PlaybackInfo 缓存优先级

#### 🔒 安全与隐私

- Token-Aware 缓存键隔离
- 自动清理 Hop-by-Hop 头（RFC 7230 兼容）
- 管理界面 Bearer Token 认证
- 敏感配置本地生成，不提交 Git

---

## 🚀 快速开始

### 前置要求

- **Node.js** ≥ 18.x
- **Cloudflare 账号**（免费版即可）
- **Emby 服务器**（任意版本）

### 方式 1：自动化安装（推荐）

```bash
# 1. 克隆项目
git clone https://github.com/TimelessXiao/CF-Emby-Proxy.git
cd CF-Emby-Proxy

# 2. 运行自动化脚本（包含认证、KV 创建、配置生成）
npm run setup
```

脚本将自动完成：
- ✅ 安装 npm 依赖
- ✅ 登录 Cloudflare（浏览器授权或 API Token）
- ✅ 创建 KV Namespace（或使用现有）
- ✅ 生成 `wrangler.json` 配置文件
- ✅ 设置 `ADMIN_TOKEN` 密钥
- ✅ 验证配置完整性

### 方式 2：手动安装

<details>
<summary>展开查看手动安装步骤</summary>

#### 1. 安装 Wrangler CLI

```bash
npm install -g wrangler
```

#### 2. 登录 Cloudflare

```bash
wrangler login
```

#### 3. 安装依赖

```bash
npm install
```

#### 4. 创建 KV Namespace

```bash
npx wrangler kv:namespace create "ROUTE_MAP"
npx wrangler kv:namespace create "ROUTE_MAP" --preview
```

记录输出的 `id` 和 `preview_id`。

#### 5. 配置 wrangler.json

复制 `wrangler.json.example` 为 `wrangler.json`：

```json
{
  "name": "cf-emby-proxy",
  "main": "worker.js",
  "compatibility_date": "2024-01-01",
  "kv_namespaces": [
    {
      "binding": "ROUTE_MAP",
      "id": "your_kv_namespace_id",
      "preview_id": "your_preview_id"
    }
  ]
}
```

#### 6. 设置管理员密钥

```bash
npx wrangler secret put ADMIN_TOKEN
```

输入你的管理员密码（用于访问 `/manage` 路由管理界面）。

#### 7. 配置上游服务器

编辑 `worker.js` 第 4 行：

```javascript
UPSTREAM_URL: 'https://your-emby-server.com', // 替换为你的 Emby 服务器地址
```

</details>

### 部署到 Cloudflare

```bash
npm run deploy
```

部署成功后，你将看到：

```
✨ Successfully published your Worker to
  https://your-worker-name.your-subdomain.workers.dev
```

### 配置自定义域名（可选）

1. 在 Cloudflare 控制台添加你的域名
2. 进入 **Workers & Pages** → 选择你的 Worker
3. **设置** → **触发器** → **添加自定义域名**
4. 输入域名（如 `emby.yourdomain.com` 或 `*.emby.yourdomain.com`）

---

## ⚙️ 配置说明

### 核心配置项（worker.js）

编辑 `worker.js` 中的 `CONFIG` 对象：

| 配置项 | 说明 | 默认值 | 类型 |
|-------|------|--------|------|
| `UPSTREAM_URL` | 默认上游 Emby 服务器地址 | `https://your-emby-server.com` | String |
| `STATIC_REGEX` | 静态资源匹配正则 | 图片/CSS/JS/Emby Images 路径 | RegExp |
| `VIDEO_REGEX` | 视频流匹配正则 | `/Videos/`, `/Stream`, `/Download` | RegExp |
| `API_CACHE_REGEX` | 可缓存 API 匹配正则 | Resume, Latest, Views, NextUp | RegExp |
| `API_CACHE_BYPASS_REGEX` | 缓存旁路正则（非确定性） | `SortBy=Random` | RegExp |
| `API_TIMEOUT` | 普通 API 超时（毫秒） | 4500 | Number |
| `CRITICAL_TIMEOUT` | 关键路径超时（毫秒） | 9000 | Number |
| `ANDROID_API_TIMEOUT` | Android TV API 超时（毫秒） | 6000 | Number |
| `M3U8_TTL` | M3U8 播放列表缓存时间（秒） | 2 | Number |
| `PLAYBACKINFO_TTL` | PlaybackInfo 缓存时间（秒） | 3 | Number |
| `MAX_BODY_BUFFER` | 请求体最大缓冲（字节） | 262144 (256KB) | Number |
| `ROUTE_CACHE_TTL` | 路由表内存缓存（秒） | 60 | Number |

### 调试模式

启用详细性能日志（包含缓存命中、回源延迟等指标）：

```bash
npx wrangler secret put DEBUG
# 输入: true
```

部署后，响应头将包含 `Server-Timing`：

```
Server-Timing: kind;desc="playbackinfo", kv_read;dur=12, cache_hit;desc="1", upstream;dur=0, subreq;desc="0"
```

---

## 📊 缓存策略

### 缓存决策流程

```
请求到达
  ├─ 视频流/Range请求? ──→ 直连透传（不缓存）
  ├─ WebSocket? ──────────→ 直连透传（不缓存）
  ├─ PlaybackInfo POST?
  │    ├─ 有 Content-Length ≤256KB? ──→ 缓冲并缓存
  │    └─ 无 Content-Length? ────────→ 流式缓冲64KB，成功则缓存
  ├─ API GET（白名单）? ────────────→ 边缘缓存 10s（强制覆盖源站头）
  ├─ Tag 图片（/Items/*/Images/?tag=*）?
  │    ├─ 匿名请求? ──→ 公共缓存 1 年（immutable）
  │    └─ 认证请求? ──→ Token 隔离缓存 1 年
  └─ 其他静态资源? ──→ 认证用户缓存 1 年，匿名 no-store
```

### 缓存层级

| 层级 | 缓存位置 | 适用场景 | TTL | 特点 |
|-----|---------|---------|-----|------|
| **L1** | Cloudflare 边缘缓存 | 静态资源、Tag 图片 | 1 年 | 全球分布，共享缓存 |
| **L2** | Cloudflare 边缘缓存 | API 白名单端点 | 10 秒 | 仅边缘缓存，浏览器不缓存 |
| **L3** | caches.default API | PlaybackInfo POST, M3U8 | 2-3 秒 | 单 POP 缓存，Token 隔离 |

### 缓存键策略

**Token 隔离（认证 API/静态）**：
```
cacheKey = pathname + sortedQuery + "::" + SHA256(token:deviceId)
```

**公共缓存（Tag 图片）**：
```
cacheKey = pathname + sortedQuery  // 无 token
```

**PlaybackInfo 缓存**：
```
cacheKey = "https://cache.playbackinfo.local" + pathname + sortedQuery + "&h=" + tokenHash + "&b=" + SHA256(body)
```

### 响应头策略

| 场景 | Cache-Control | 说明 |
|-----|--------------|------|
| API 边缘缓存 | `public, max-age=0, s-maxage=10` | 仅边缘缓存，浏览器实时验证 |
| Tag 图片（公共） | `public, max-age=31536000, immutable` | 长期缓存，内容不可变 |
| 认证静态资源 | `public, max-age=31536000, immutable` | Token 隔离长期缓存 |
| PlaybackInfo | `private, max-age=3` | 用户私有，短期缓存 |
| 匿名非 Tag 静态 | `no-store, no-cache, must-revalidate` | 禁止缓存（防泄露） |

---

## 🗺️ 动态路由管理

### 管理界面

访问 `https://your-worker.workers.dev/manage`（或你的自定义域名 + `/manage`）

**认证**：使用部署时设置的 `ADMIN_TOKEN`

### 路由配置示例

```json
{
  "stream1": {
    "upstream": "https://emby-server-1.example.com",
    "pathPrefix": ""
  },
  "stream2": {
    "upstream": "https://emby-server-2.example.com",
    "pathPrefix": "/emby"
  },
  "default": {
    "upstream": "https://main-emby.example.com",
    "pathPrefix": ""
  }
}
```

**路由逻辑**：
- `stream1.yourdomain.com` → `emby-server-1.example.com`
- `stream2.yourdomain.com` → `emby-server-2.example.com/emby`
- `yourdomain.com` 或其他子域 → `main-emby.example.com`

### KV 存储结构

**Pointer Key**: `routes:current` → 当前版本号（如 `v1738012345678`）

**Version Key**: `routes:v1738012345678` → 完整配置文档（含 mappings、编辑者、时间戳）

**内存缓存**：60 秒 TTL，减少 KV 读取开销

---

## 🔧 开发与调试

### 本地开发

```bash
npm run dev
```

Worker 将在本地运行，访问 `http://localhost:8787`

**注意**：本地模式使用 `--remote` 标志连接真实 KV，确保数据一致性。

### 日志查看

```bash
# 实时查看生产日志
npx wrangler tail

# 过滤特定请求
npx wrangler tail --format pretty | grep "PlaybackInfo"
```

### 性能分析

启用 `DEBUG=true` 后，每个请求返回 `Server-Timing` 头：

```http
Server-Timing:
  kind;desc="playbackinfo",
  kv_read;dur=12,
  cache_hit;desc="1",
  upstream;dur=0,
  retry;desc="0",
  subreq;desc="0"
```

**指标说明**：
- `kind`：请求类型（media/playbackinfo/api/m3u8）
- `kv_read`：KV 读取耗时（毫秒）
- `cache_hit`：缓存命中（0=MISS, 1=HIT）
- `upstream`：上游响应耗时（毫秒）
- `subreq`：子请求次数

---

## 🧪 验证清单

### PlaybackInfo 缓存验证

```bash
# 第一次请求（MISS）
curl -X POST "https://your-worker.dev/Items/123/PlaybackInfo" \
  -H "X-Emby-Token: your_token" \
  -H "Content-Type: application/json" \
  -d '{"DeviceProfile":{}}' \
  -i | grep "Server-Timing"
# 预期: cache_hit;desc="0"

# 第二次请求（HIT）
curl -X POST "https://your-worker.dev/Items/123/PlaybackInfo" \
  -H "X-Emby-Token: your_token" \
  -H "Content-Type: application/json" \
  -d '{"DeviceProfile":{}}' \
  -i | grep "Server-Timing"
# 预期: cache_hit;desc="1"
```

### API 边缘缓存验证

```bash
# Resume 端点
curl "https://your-worker.dev/Users/123/Items/Resume?api_key=your_key" \
  -i | grep -E "(cf-cache-status|Cache-Control)"
# 第一次: cf-cache-status: MISS
# 第二次: cf-cache-status: HIT
# Cache-Control: public, max-age=0, s-maxage=10

# SortBy=Random 应该 BYPASS
curl "https://your-worker.dev/Users/123/Items?SortBy=Random&api_key=your_key" \
  -i | grep "cf-cache-status"
# 预期: cf-cache-status: BYPASS 或 DYNAMIC
```

### Tag 图片匿名缓存验证

```bash
# 匿名请求 tag 图片（公共缓存）
curl "https://your-worker.dev/Items/123/Images/Primary?tag=abc123&maxWidth=400" \
  -i | grep -E "(cf-cache-status|Cache-Control)"
# 预期: Cache-Control: public, max-age=31536000, immutable
# 第二次: cf-cache-status: HIT

# 无 tag 图片（应该 no-store）
curl "https://your-worker.dev/Items/123/Images/Primary?maxWidth=400" \
  -i | grep "Cache-Control"
# 预期: Cache-Control: no-store, no-cache, must-revalidate

# /Users/ 路径（即使有 tag 也不公开缓存）
curl "https://your-worker.dev/Users/1/Images/Primary?tag=xyz" \
  -i | grep "Cache-Control"
# 预期: Cache-Control: no-store
```

---

## 📦 CI/CD 集成

### GitHub Actions 示例

```yaml
name: Deploy to Cloudflare Workers

on:
  push:
    branches: [main]

jobs:
  deploy:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4

      - uses: actions/setup-node@v4
        with:
          node-version: '18'

      - name: Setup CF-Emby-Proxy
        env:
          CI: true
          KV_NAMESPACE_ID: ${{ secrets.KV_NAMESPACE_ID }}
          CLOUDFLARE_API_TOKEN: ${{ secrets.CLOUDFLARE_API_TOKEN }}
          ADMIN_TOKEN: ${{ secrets.ADMIN_TOKEN }}
        run: npm run setup

      - name: Deploy to Cloudflare
        run: npm run deploy
```

### 环境变量说明

| 变量 | 说明 | 必需 |
|-----|------|------|
| `CI` | 启用非交互模式 | ✅ |
| `KV_NAMESPACE_ID` | KV Namespace ID（32 位十六进制） | ✅ |
| `CLOUDFLARE_API_TOKEN` | Cloudflare API Token | ✅（CI 环境） |
| `KV_PREVIEW_ID` | 预览环境 KV ID | ❌（默认同 production） |
| `ADMIN_TOKEN` | 管理员密钥 | ❌（跳过则不设置） |

---

## 🐛 常见问题

<details>
<summary><strong>Q: 视频播放卡顿/无法播放？</strong></summary>

**A**: 视频流采用直连透传策略，不经过缓存。可能原因：
1. 源站网络问题：检查 Emby 服务器网络状况
2. Cloudflare 路由问题：确认 Workers 路由未干扰视频流
3. 客户端兼容性：部分客户端可能需要调整 `ANDROID_API_TIMEOUT`

**解决方案**：
```javascript
// worker.js 调整超时
API_TIMEOUT: 6000,  // 增加到 6 秒
CRITICAL_TIMEOUT: 12000  // 增加到 12 秒
```
</details>

<details>
<summary><strong>Q: 管理界面无法访问（401 Unauthorized）？</strong></summary>

**A**: 检查以下几点：
1. 确认已设置 `ADMIN_TOKEN`：
   ```bash
   npx wrangler secret list
   # 应该看到 ADMIN_TOKEN
   ```
2. 重新设置密钥：
   ```bash
   npx wrangler secret put ADMIN_TOKEN
   ```
3. 清除浏览器缓存，使用无痕模式重新输入 Token
</details>

<details>
<summary><strong>Q: PlaybackInfo 缓存未生效（仍然很慢）？</strong></summary>

**A**: 排查步骤：
1. 检查客户端是否发送 `Content-Length`：
   ```bash
   npx wrangler tail | grep "PlaybackInfo"
   ```
2. 确认请求体 <64KB：超过此限制会回退到非缓存模式
3. 验证 `tokenHash` 一致性：不同设备 ID 会导致缓存键不同
4. 启用 DEBUG 模式查看 `cache_hit` 指标
</details>

<details>
<summary><strong>Q: 图片加载慢，但应该有缓存？</strong></summary>

**A**: 检查：
1. 确认 URL 包含 `tag` 参数：
   ```
   /Items/123/Images/Primary?tag=abc123  ✅
   /Items/123/Images/Primary             ❌（无 tag，不缓存）
   ```
2. 首次加载必定回源（MISS），第二次应该 HIT
3. 验证 `cf-cache-status` 响应头
4. 确认不在 `/Users/` 或 `/Persons/` 路径下
</details>

<details>
<summary><strong>Q: 多设备同步延迟（Resume 位置不一致）？</strong></summary>

**A**: 这是 10 秒 API 边缘缓存的预期行为：
- 设备 A 暂停 → 10 秒内设备 B 可能读取旧进度
- **可接受范围**：<10 秒延迟对 99% 使用场景无影响
- **如需实时同步**：修改 `API_CACHE_REGEX` 排除 Resume 端点

```javascript
// 禁用 Resume 缓存（实时性优先）
API_CACHE_REGEX: /(\/Users\/.*\/Items\/Latest|\/Users\/.*\/Views|\/Shows\/NextUp)/i,
```
</details>

<details>
<summary><strong>Q: KV Namespace 创建失败？</strong></summary>

**A**: 可能原因：
1. Cloudflare 账号未验证邮箱
2. Free Plan 达到 KV Namespace 配额（通常为 100 个）
3. 网络问题导致 API 调用超时

**解决方案**：
1. 手动在 Cloudflare Dashboard 创建 KV
2. 复制 ID 到 `wrangler.json`
3. 重新运行 `npm run setup`，选择"使用现有 Namespace"
</details>

<details>
<summary><strong>Q: wrangler.json 缺失？</strong></summary>

**A**: `wrangler.json` 由 `npm run setup` 自动生成，不应手动创建。如果丢失：
```bash
# 重新运行 setup 脚本
npm run setup

# 或手动复制模板
cp wrangler.json.example wrangler.json
# 然后编辑填入你的 KV ID
```
</details>

---

## 🏗️ 技术架构

### 技术栈

- **Runtime**: Cloudflare Workers（V8 Isolates）
- **Framework**: [Hono](https://hono.dev/) - 轻量级 Web 框架
- **Storage**: Cloudflare KV（路由配置）、Cache API（响应缓存）
- **Language**: JavaScript ES2022

### 核心模块

```
worker.js (1300+ lines)
├─ CONFIG                      # 配置对象
├─ Utility Functions
│  ├─ sha256Hex()              # SHA-256 哈希
│  ├─ buildTokenKey()          # Token 缓存键生成
│  ├─ readBodyWithLimit()      # 流式缓冲（新增）
│  ├─ cleanupHopByHopHeaders() # RFC 7230 头清理
│  └─ fetchWithTimeout()       # 超时控制 fetch
├─ KV-backed Dynamic Routing
│  ├─ loadRouteMappings()      # 加载路由表（60s 内存缓存）
│  ├─ publishRouteMappings()   # 发布新路由
│  └─ Route versioning         # 版本控制 + 回滚支持
├─ Management Endpoints (/manage)
│  ├─ GET /manage              # 管理界面 HTML
│  ├─ GET /api/mappings        # 获取路由列表
│  ├─ PUT /api/mappings/:sub   # 更新路由
│  ├─ DELETE /api/mappings/:sub # 删除路由
│  ├─ POST /api/batch-delete   # 批量删除
│  ├─ POST /api/import         # 导入配置
│  ├─ GET /api/export          # 导出配置
│  └─ POST /api/rollback       # 版本回滚
└─ Main Proxy Handler (app.all('*'))
   ├─ Request Classification   # 请求类型检测
   ├─ Buffering Logic          # 请求体缓冲（含流式）
   ├─ Cache Key Generation     # Token-aware 缓存键
   ├─ CF Config Setup          # Cloudflare 缓存配置
   ├─ Upstream Fetch           # 上游请求（含超时/重试）
   ├─ Response Processing      # 响应头覆盖 + 清理
   └─ Performance Logging      # Server-Timing 指标
```

### 缓存架构图

```
┌─────────────────────────────────────────────────────────────┐
│                    Cloudflare Edge Network                  │
├─────────────────────────────────────────────────────────────┤
│                                                             │
│  ┌──────────────┐    ┌──────────────┐    ┌──────────────┐ │
│  │  Browser     │───▶│  CF Worker   │───▶│ Origin Emby  │ │
│  └──────────────┘    └──────────────┘    └──────────────┘ │
│                            │                                │
│                            ├─ L1: Edge Cache (Static 1yr)  │
│                            ├─ L2: Edge Cache (API 10s)     │
│                            └─ L3: caches.default (POST 3s) │
│                                                             │
│  Cache Key Strategy:                                        │
│  • Token Isolation: pathname + query + "::" + tokenHash    │
│  • Public Tag Art:  pathname + query (no token)            │
│  • PlaybackInfo:    pathname + query + bodyHash + tokenHash│
└─────────────────────────────────────────────────────────────┘
```

### 性能优化技术

1. **增量流式缓冲**：防止大请求体耗尽内存
2. **KV 内存缓存**：60 秒本地缓存减少 KV 读取
3. **提前终止读取**：超过 64KB 立即 cancel stream
4. **CPU 优化哈希**：仅在需要缓存键时计算 tokenHash
5. **参数排序**：查询参数字典序排序保证缓存键稳定性



## 🤝 贡献指南

欢迎贡献代码、报告 Bug、提出改进建议！

### 开发流程

1. Fork 本仓库
2. 创建特性分支：`git checkout -b feature/amazing-feature`
3. 提交更改：`git commit -m 'Add amazing feature'`
4. 推送分支：`git push origin feature/amazing-feature`
5. 提交 Pull Request

### 代码规范

- 保持单文件架构（`worker.js`）
- 遵循现有注释风格（中文注释 + 英文代码）
- 新增配置项添加到 `CONFIG` 对象
- 关键功能添加对应测试场景说明

---

## 📄 许可证

[ISC License](https://opensource.org/licenses/ISC)

Copyright (c) 2024-2026 CF-Emby-Proxy Contributors

---

## 🙏 致谢

- linuxdo社区佬nzh提供的原项目：https://github.com/fast63362/CF-Emby-Proxy

---

<div align="center">

**Made with ❤️ for Emby Users**

如果这个项目对你有帮助，请给个 ⭐ Star！

</div>
