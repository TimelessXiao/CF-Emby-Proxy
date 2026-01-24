# CF-Emby-Proxy 实施计划

**版本**: v1.0.0
**日期**: 2026-01-24

---

## 📋 项目概述

本项目实现了两个核心目标：
1. **自动化部署**：通过交互式脚本简化首次本地部署流程
2. **隐私保护**：移除配置文件中的敏感信息，准备开源到 GitHub

### 技术方案
- **配置管理**：模板+生成模式（wrangler.json.example → wrangler.json）
- **脚本语言**：Node.js（无外部依赖，跨平台）
- **安全策略**：敏感配置本地生成，git-ignored

---

## 📁 文件结构变更

### 新增文件
```
CF-Emby-Proxy/
├── wrangler.json.example    # 配置模板（占位符）
├── scripts/
│   └── setup.js             # 自动化设置脚本
└── docs/
    └── IMPLEMENTATION_PLAN.md  # 本文档
```

### 修改文件
- `.gitignore` - 添加 `wrangler.json`
- `package.json` - 添加 scripts，修正 main 字段

### 删除文件
- `wrangler.json` - 从 VCS 移除（本地生成）

---

## 🚀 使用指南

### 首次设置
```bash
git clone https://github.com/your-username/CF-Emby-Proxy.git
cd CF-Emby-Proxy
npm run setup
```

脚本将引导您完成：
1. 安装依赖（npm install）
2. Cloudflare 认证（浏览器登录或 API token）
3. KV namespace 创建/选择
4. 生成 wrangler.json 配置
5. 设置 ADMIN_TOKEN secret
6. 验证配置

### 日常开发
```bash
npm run dev      # 本地开发服务器
npm run deploy   # 部署到 Cloudflare
```

### CI/非交互模式
脚本支持在 CI 环境中自动运行，无需人工交互。通过环境变量提供配置信息。

#### 启用方式
设置以下任一环境变量：
- `CI=true` - 标准 CI 环境检测
- `SETUP_NONINTERACTIVE=1` - 显式启用非交互模式

#### 必需环境变量
- `KV_NAMESPACE_ID` - KV namespace ID（32位十六进制）
- `CLOUDFLARE_API_TOKEN` - Cloudflare API 令牌（可选，如已认证可省略）

#### 可选环境变量
- `KV_PREVIEW_ID` - 预览环境 KV ID（默认使用 KV_NAMESPACE_ID）
- `ADMIN_TOKEN` - 管理员令牌（跳过则不设置 secret）

#### 使用示例

**本地测试 CI 模式**：
```bash
CI=true \
  KV_NAMESPACE_ID=abc123def456... \
  CLOUDFLARE_API_TOKEN=your_token \
  ADMIN_TOKEN=your_admin_token \
  npm run setup
```

**GitHub Actions 示例**：
```yaml
- name: Setup CF-Emby-Proxy
  env:
    CI: true
    KV_NAMESPACE_ID: ${{ secrets.KV_NAMESPACE_ID }}
    CLOUDFLARE_API_TOKEN: ${{ secrets.CLOUDFLARE_API_TOKEN }}
    ADMIN_TOKEN: ${{ secrets.ADMIN_TOKEN }}
  run: npm run setup
```

---

## 🔒 安全考虑

### 敏感数据保护
- **KV Namespace ID**: 不再提交到 Git
- **ADMIN_TOKEN**: 使用 wrangler secret 管理
- **wrangler.json**: 本地生成，git-ignored

### 配置文件说明
- `wrangler.json.example` - 公开模板（占位符）
- `wrangler.json` - 本地配置（真实 ID，不提交）

---

## 📝 实施细节

### Setup 脚本功能
- ✅ Node.js 版本检查（>= 18）
- ✅ 跨平台兼容（Windows/Linux/Mac）
- ✅ 交互式提示（Y/N 问题，多选一）
- ✅ CI/非交互模式（环境变量驱动）
- ✅ ANSI 彩色输出（增强可读性）
- ✅ 错误处理和输入验证
- ✅ KV namespace 创建/解析（JSON 输出）
- ✅ 配置覆盖保护（备份机制）
- ✅ KV 创建失败回滚

### 脚本流程
1. Pre-flight: 验证环境，安装依赖
2. Authentication: wrangler login 或 API token
3. KV Setup: 创建或使用现有 namespace
4. Config Generation: 从模板生成 wrangler.json
5. Secrets: 设置 ADMIN_TOKEN
6. Validation: 验证配置和连接

---

## ⚠️ 注意事项

1. **首次运行**：必须先执行 `npm run setup`
2. **KV Binding**: 名称必须为 `ROUTE_MAP`（与 worker.js 匹配）
3. **环境支持**：仅默认环境（不支持 production/staging）
4. **Git 提交**：确保 wrangler.json 在 .gitignore 中

---

## 🔄 升级路径

如果您已有旧版本配置：
1. 备份当前 wrangler.json 中的 KV ID
2. 运行 `npm run setup`
3. 选择"使用现有 KV namespace IDs"
4. 输入备份的 ID

---

## 📚 相关文档

- `.claude/plan/CF-Emby-Proxy-Security-Automation.md` - 详细规划文档
- `README.md` - 项目说明
- `.claude/delivery/DEPLOYMENT-GUIDE.md` - 部署指南

---

**实施状态**: ✅ 已完成
**测试状态**: 待验证
