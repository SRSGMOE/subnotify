# 订阅到期通知面板

基于 Cloudflare Workers + D1 数据库 + Telegram Bot 的订阅管理系统。

## 功能特性

- ✅ 添加/编辑/删除订阅
- ✅ 支持多种通知周期：每日/每周/每月/每年/指定日期
- ✅ Telegram Bot 自动通知
- ✅ Telegram Bot 命令管理
- ✅ 响应式 Web 管理界面
- ✅ 通知历史记录
- ✅ 定时自动检查

## 项目结构

```
├── src/
│   ├── index.js          # 主入口和API路由
│   └── telegram-bot.js   # Telegram Bot处理
├── public/
│   └── index.html        # 前端界面
├── schema.sql            # 数据库结构
├── wrangler.toml         # Cloudflare配置
└── package.json
```

## 部署步骤

### 1. 准备工作

1. 注册 [Cloudflare](https://cloudflare.com) 账号
2. 安装 Node.js (推荐 v18+)
3. 创建 Telegram Bot：
   - 在 Telegram 中找到 @BotFather
   - 发送 `/newbot` 创建机器人
   - 获取 Bot Token

### 2. 安装依赖

```bash
npm install
```

### 3. 创建 D1 数据库

```bash
# 创建数据库
npx wrangler d1 create subscription-db

# 记录输出的 database_id，更新到 wrangler.toml
```

### 4. 初始化数据库

```bash
npx wrangler d1 execute subscription-db --file=./schema.sql
```

### 5. 配置环境变量（重要！）

**不要在代码中填写敏感信息！** 请在 Cloudflare Dashboard 中设置环境变量：

1. 登录 [Cloudflare Dashboard](https://dash.cloudflare.com)
2. 进入 **Workers & Pages** → 选择你的 Worker
3. 点击 **Settings** → **Variables**
4. 添加以下 **环境变量** 或 **Secret**：

| 变量名 | 类型 | 说明 |
|--------|------|------|
| `TELEGRAM_BOT_TOKEN` | Secret | Telegram Bot Token |
| `TELEGRAM_CHAT_ID` | Secret | 你的 Telegram Chat ID |

**推荐使用 "Secret" 类型**，这样变量会被加密存储，更安全。

**获取 Chat ID：**
1. 向你的 Bot 发送任意消息
2. 访问 `https://api.telegram.org/bot<你的TOKEN>/getUpdates`
3. 找到 `chat.id` 字段

**或者使用 Wrangler CLI 设置 Secrets：**
```bash
npx wrangler secret put TELEGRAM_BOT_TOKEN
# 输入你的 Bot Token

npx wrangler secret put TELEGRAM_CHAT_ID
# 输入你的 Chat ID
```

### 6. 部署

```bash
# 部署到 Cloudflare Workers
npx wrangler deploy
```

### 7. 设置 Telegram Webhook

部署完成后，访问以下 URL 设置 Webhook：

```
https://api.telegram.org/bot<你的TOKEN>/setWebhook?url=https://你的域名/webhook/telegram
```

### 8. 设置定时触发器

在 Cloudflare Dashboard 中：
1. 进入你的 Worker
2. 点击 "Triggers" 标签
3. 添加 Cron Trigger: `0 9 * * *` (每天早上9点)

## Telegram Bot 命令

| 命令 | 说明 |
|------|------|
| `/start` | 显示欢迎信息 |
| `/help` | 显示帮助 |
| `/list` | 查看所有订阅 |
| `/add 名称\|内容\|周期\|值` | 添加订阅 |
| `/today` | 查看今日待通知 |
| `/notify` | 立即检查并发送通知 |
| `/status` | 查看系统状态 |

### 添加订阅示例

```
/add 服务器续费|AWS EC2|monthly|15
/add 域名续费|example.com|yearly|6-15
/add 每周报告|提交周报|weekly|5
/add 会员到期|Netflix|specific|2025-12-31
```

## 周期类型说明

| 类型 | 说明 | 值示例 |
|------|------|--------|
| `daily` | 每天 | 无需填写 |
| `weekly` | 每周 | 1-7 (周一到周日) |
| `monthly` | 每月 | 1-31 (日期) |
| `yearly` | 每年 | MM-DD (如 12-25) |
| `specific` | 指定日期 | YYYY-MM-DD |

## 本地开发

### 方法一：使用 .dev.vars 文件（推荐）

创建 `.dev.vars` 文件（此文件已在 .gitignore 中，不会被提交）：

```bash
TELEGRAM_BOT_TOKEN=你的Bot Token
TELEGRAM_CHAT_ID=你的Chat ID
```

然后启动开发服务器：

```bash
npm run dev
# 访问 http://8787
```

### 方法二：使用 Wrangler CLI

```bash
npx wrangler dev --var TELEGRAM_BOT_TOKEN:你的Token --var TELEGRAM_CHAT_ID:你的ChatID
```

### 创建 .gitignore

```bash
echo ".dev.vars" >> .gitignore
echo "node_modules/" >> .gitignore
echo ".wrangler/" >> .gitignore
```

## 注意事项

1. 确保 Telegram Bot Token 和 Chat ID 配置正确
2. D1 数据库需要先创建并初始化
3. 定时任务会每天早上 9 点自动检查
4. 可以通过 Web 界面或 Telegram Bot 管理订阅

## 许可证

MIT