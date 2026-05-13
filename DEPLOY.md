# Cloudflare Pages 部署指南

## 📋 完整部署步骤

### 1. 推送代码到 GitHub

将代码推送到你的 GitHub 仓库。

### 2. 创建 Pages 项目

1. 登录 [Cloudflare Dashboard](https://dash.cloudflare.com)
2. 进入 **Workers & Pages**
3. 点击 **Create Application** → **Pages** → **Connect to Git**
4. 选择你的 GitHub 仓库

### 3. 构建配置

```
Framework preset: None
Build command: （留空）
Build output directory: public
```

### 4. 创建 D1 数据库

1. 在 Dashboard 进入 **Workers & Pages** → **D1**
2. 点击 **Create database**
3. 名称输入：`subscription-db`
4. 创建后记录 **Database ID**（后续需要）

### 5. 绑定 D1 数据库

部署成功后，进入你的 Pages 项目：

1. **Settings** → **Functions**
2. 找到 **D1 Database Bindings**
3. 点击 **Add binding**
4. Variable name: `DB`
5. D1 database: 选择刚创建的 `subscription-db`

### 6. 设置环境变量（Secrets）

在 **Settings** → **Environment variables** 中添加：

| 变量名 | 类型 | 说明 |
|--------|------|------|
| `ADMIN_PASSWORD` | Secret | 管理员登录密码 |
| `TELEGRAM_BOT_TOKEN` | Secret | Telegram Bot Token |
| `TELEGRAM_CHAT_ID` | Secret | Telegram Chat ID |

> ⚠️ 重要：所有变量都要选择 **Secret** 类型！

### 7. 设置定时触发器

1. 进入 **Settings** → **Functions**
2. 找到 **Cron Triggers**
3. 添加：`0 9 * * *`（每天早上9点检查）

### 8. 配置 Telegram Webhook

部署完成后，访问以下 URL 设置 Webhook：

```
https://api.telegram.org/bot<你的TOKEN>/setWebhook?url=https://<你的域名>/webhook/telegram
```

---

## 🔧 环境变量说明

| 变量名 | 必填 | 说明 |
|--------|------|------|
| `ADMIN_PASSWORD` | 是 | 管理员密码，用于登录面板 |
| `TELEGRAM_BOT_TOKEN` | 是 | Telegram Bot Token |
| `TELEGRAM_CHAT_ID` | 是 | 接收通知的 Chat ID |
| `DB` | 是 | D1 数据库绑定（通过 Dashboard 配置） |

---

## ❓ 常见问题

### Q: 部署后显示 404？

A: 确保 Build output directory 设置为 `public`

### Q: API 返回错误？

A: 检查 D1 数据库是否正确绑定（变量名必须是 `DB`）

### Q: 无法登录？

A: 确保已设置 `ADMIN_PASSWORD` 环境变量

### Q: Telegram 通知不工作？

A: 检查 `TELEGRAM_BOT_TOKEN` 和 `TELEGRAM_CHAT_ID` 是否正确