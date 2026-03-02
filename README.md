# CF-Emby-Proxy

基于 Cloudflare Workers 的 Emby 反向代理与边缘加速方案，支持动态路由、细粒度缓存策略和可视化管理。

- 仓库地址: <https://github.com/TimelessXiao/CF-Emby-Proxy>
- 运行时: Cloudflare Workers + Hono
- Node.js: >= 18

## 目录

- [核心能力](#核心能力)
- [项目结构](#项目结构)
- [请求处理与缓存策略](#请求处理与缓存策略)
- [动态路由与管理接口](#动态路由与管理接口)
- [安全策略](#安全策略)
- [快速开始](#快速开始)
- [配置说明](#配置说明)
- [开发与调试](#开发与调试)
- [常见场景](#常见场景)
- [许可证](#许可证)

## 核心能力

1. Emby 请求代理
- 按子域名动态选择上游 Emby。
- 支持 `pathPrefix`，可将不同子域路由到不同上游路径。

2. 多层路由缓存（配置层）
- L1: Worker 内存缓存（默认 60s）。
- L2: Cloudflare Cache API（软 TTL 60s，硬 TTL 30 天）。
- L3: KV 持久化存储（版本化文档）。

3. 媒体播放稳定性优化
- 媒体/Range 请求独立的 TTFB 超时控制（默认 15s）。
- 失败重试、退避、空闲 watchdog、客户端取消信号透传。
- 对特定媒体路径与播放器进行“原生流直通（bypass）”。

4. 精细缓存策略（内容层）
- PlaybackInfo POST 微缓存（3s，带请求体 hash）。
- API 端点微缓存（10s，带 query 去噪 + token 隔离）。
- M3U8 微缓存（2s）。
- 图片长期缓存 / 空 tag 图片短缓存（90s）。

5. 管理界面与管理 API
- `/manage` 内置管理页面。
- 支持新增、编辑、删除、批量删除、导入、导出、回滚。
- 基于版本号（`If-Match`）做并发写保护。

6. 调试与可观测性
- `Server-Timing` 注入（采样 + 媒体强制记录）。
- 可选非 2xx 详细日志，支持脱敏。

## 项目结构

```text
src/
  worker.js      # 核心代理、缓存、安全与管理 API
  ui.js          # /manage 管理界面 HTML
  debug.js       # Server-Timing 与详细日志工具

scripts/
  setup.js       # 交互式/非交互式初始化脚本

wrangler.json.example  # 示例部署配置（可提交）
wrangler.json          # 本地实际配置（默认 git 忽略）
```

## 请求处理与缓存策略

### 1) 路由选择

常规模式：
- 从请求 hostname 提取一级子域名。
- 在路由映射中按 `subdomain` 查找上游。
- 未命中时使用 `default`，再回退 `UPSTREAM_URL`。

代理路径模式：
- 当路径形如 `/https://target.example/path` 时，直接代理到目标 URL。
- 会附带原始 query 参数。

### 2) 主要缓存规则

1. PlaybackInfo（POST）
- 路径匹配 `/PlaybackInfo`。
- 仅在可缓冲请求体且存在真实 token 时启用。
- 以 `hostname + pathname + sorted query + token hash + body hash` 作为缓存键。
- TTL: 3 秒（`PLAYBACKINFO_TTL`）。

2. API 微缓存（GET）
- 覆盖 `/Items`、`/Items/Resume`、`/Users/*/Items/Latest`、`/Users/*/Views`、`/Shows/NextUp`。
- `SortBy=Random` 会绕过缓存。
- 仅保留白名单 query 参数构建缓存键，减少噪声。
- TTL: 10 秒（`s-maxage=10`）。

3. M3U8（GET）
- 匹配 `.m3u8`。
- 带 token hash 缓存键隔离。
- TTL: 2 秒。

4. 图片缓存
- 带有效 `tag` 的 Items 图片：长期缓存（1 年，`immutable`）。
- 无 `tag` 且匿名请求的 Items 图片：短缓存（90s）。
- `/Users/`、`/Persons/` 相关图片不走匿名长期缓存。

5. 视频 / Range
- 不走常规边缘缓存。
- 强制 `Accept-Encoding: identity`，降低媒体中间链路异常概率。

### 3) 媒体稳定性逻辑

- TTFB 超时：`MEDIA_TTFB_TIMEOUT_MS`（默认 15000ms）。
- 网络错误快速重试（幂等请求）。
- 首块读取超时 + 空闲超时 watchdog。
- 特定条件下 bypass JS 包装流，直接透传上游 body：
  - Range 请求
  - 媒体 MIME 类型
  - 典型媒体路径（含 `/Videos/`、`/Items/*/Stream`、`/stream/*`、媒体后缀）
  - 原生播放器特征（如 infuse/exoplayer/mpv）

## 动态路由与管理接口

### 路由数据模型

```json
{
  "stream1": {
    "upstream": "https://emby-a.example.com",
    "pathPrefix": ""
  },
  "stream2": {
    "upstream": "https://emby-b.example.com",
    "pathPrefix": "/emby"
  },
  "default": {
    "upstream": "https://emby-main.example.com",
    "pathPrefix": ""
  }
}
```

### 版本化存储

- 当前指针：`routes:current`
- 历史版本：`routes:v{timestamp}`
- 每次写入生成新版本并记录 `prev`，支持回滚。

### 管理界面

- 路径: `/manage`
- 认证: `Authorization: Bearer <ADMIN_TOKEN>`

### 管理 API（均需 Bearer Token）

- `GET /manage/api/mappings` 读取当前映射和版本
- `PUT /manage/api/mappings/:sub` 新增/更新路由
- `DELETE /manage/api/mappings/:sub` 删除路由
- `POST /manage/api/batch-delete` 批量删除
- `GET /manage/api/export` 导出配置
- `POST /manage/api/import` 导入配置
- `POST /manage/api/rollback` 回滚到上一个或指定版本

并发写保护：
- 通过 `If-Match` + 当前版本做乐观锁。
- 冲突返回 `409 Version conflict`。

## 安全策略

1. SSRF 防护
- 代理路径模式仅允许 `http/https`。
- 拒绝内网/保留地址（IPv4/IPv6/localhost 等）。
- 重定向目标也会做同样校验。

2. 凭证保护
- 代理路径模式下剥离 `Authorization`、`Cookie`、`X-Emby-Token` 等敏感头，防止泄露到第三方。

3. 缓存隔离
- 基于 `token + deviceId` 计算 SHA-256 缓存键，避免跨用户缓存污染。

4. 协议头治理
- 清理 hop-by-hop headers，降低中间层协议不兼容问题。

## 快速开始

### 1) 安装依赖

```bash
npm install
```

### 2) 运行初始化脚本（推荐）

```bash
npm run setup
```

`scripts/setup.js` 会引导你完成：
- Cloudflare 认证（`wrangler login` 或 API Token）
- KV namespace 创建或复用
- 从 `wrangler.json.example` 生成 `wrangler.json`
- 设置 `ADMIN_TOKEN` Secret
- 基础配置验证

### 3) 本地调试

```bash
npm run dev
```

### 4) 部署

```bash
npm run deploy
```

## 配置说明

### wrangler 关键项

必须配置：
- `kv_namespaces` 绑定 `ROUTE_MAP`
- Secret `ADMIN_TOKEN`

常用 vars：
- `UPSTREAM_URL`: 默认上游（无路由命中时兜底）
- `DEBUG`: `true/false`
- `DEBUG_LOG_NON_2XX`: 是否记录非 2xx 详细日志
- `DEBUG_LOG_REDACT`: 是否对日志脱敏

可选 vars：
- `ROUTE_CACHE_HOST`: 路由 L2 缓存 key 的隔离 host（不配则使用内置默认）

### setup 非交互模式（CI 可用）

当 `CI=true` 或 `SETUP_NONINTERACTIVE=1` 时：

必需环境变量：
- `KV_NAMESPACE_ID`

可选环境变量：
- `CLOUDFLARE_API_TOKEN`
- `KV_PREVIEW_ID`
- `ADMIN_TOKEN`

## 开发与调试

### NPM Scripts

- `npm run setup`: 初始化环境
- `npm run dev`: 本地开发
- `npm run deploy`: 部署到 Cloudflare

### 日志与诊断

启用 `DEBUG=true` 后，响应会按采样附带 `Server-Timing`。
可通过 `wrangler tail` 结合 `DEBUG_LOG_NON_2XX` 观察异常请求详情。

## 常见场景

1. 多线路分流
- `a.example.com` 和 `b.example.com` 指向不同 Emby 上游。
- 通过 `/manage` 在线增删路由，约 60 秒内全局生效（受缓存 TTL 影响）。

2. 复杂跨域资源代理
- 使用路径模式：`https://proxy.example.com/https://cdn.example.com/video.mkv?token=...`
- Worker 会处理重定向并继续包裹为代理路径，避免断链。

3. 降低首页接口延迟
- 使用 API 微缓存和 PlaybackInfo 微缓存，减少频繁回源。

## 许可证

ISC License
