# Cloudflare 部署指南

## 方式一：使用 Cloudflare Workers（推荐）

### 1. 本地安装 Wrangler CLI

```bash
npm install -g wrangler
```

### 2. 登录 Cloudflare

```bash
wrangler login
```

### 3. 创建 D1 数据库

```bash
wrangler d1 create subscription-db
# 记录输出的 database_id
```

### 4. 更新 wrangler.toml

将 `YOUR_DATABASE_ID` 替换为上一步获取的 ID。

### 5. 设置 Secrets

```bash
wrangler secret put TELEGRAM_BOT_TOKEN
# 输入你的 Bot Token

wrangler secret put TELEGRAM_CHAT_ID
# 输入你的 Chat ID
```

### 6. 部署

```bash
wrangler deploy
```

---

## 方式二：使用 Cloudflare Pages + GitHub

### 1. 在 Cloudflare Dashboard 操作

1. 进入 **Workers & Pages**
2. 点击 **Create Application** → **Pages** → **Connect to Git**
3. 选择你的 GitHub 仓库

### 2. 构建配置

```
Production branch: main (或你的主分支名)
Framework preset: None
Build command: npm install
Build output directory: /
```

> ⚠️ 注意：Build output directory 填 `/`（斜杠），不是 `.`（点）

### 3. 环境变量

在 **Environment variables** 中添加：

| 变量名 | 值 | 类型 |
|--------|-----|------|
| TELEGRAM_BOT_TOKEN | 你的Bot Token | Encrypted |
| TELEGRAM_CHAT_ID | 你的Chat ID | Encrypted |

### 4. Functions 设置

部署成功后，进入项目：

1. **Settings** → **Functions**
2. **D1 Database Bindings**：
   - Variable name: `DB`
   - D1 database: 选择 `subscription-db`

### 5. 设置 Cron Trigger

在 **Triggers** 中添加：
```
0 9 * * *
```

---

## 常见问题

### Q: 部署后显示 404 或空白页？

A: 确保：
- Build output directory 是 `/` 不是 `.`
- `index.html` 文件在项目根目录或 `public` 目录

### Q: API 请求返回错误？

A: 检查：
- D1 数据库是否正确绑定
- 环境变量是否设置

### Q: Telegram 通知不工作？

A: 确认：
- TELEGRAM_BOT_TOKEN 和 TELEGRAM_CHAT_ID 已设置
- Webhook 已配置

## 配置 Telegram Webhook

部署成功后，访问以下 URL 设置 Webhook：

```
https://api.telegram.org/bot<你的TOKEN>/setWebhook?url=https://<你的域名>/webhook/telegram
```

将 `<你的TOKEN>` 替换为 Bot Token，`<你的域名>` 替换为你的 Pages 域名。
