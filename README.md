# 订阅到期通知面板

基于 Cloudflare Workers + D1 数据库的订阅管理系统，支持 Telegram Bot 通知。

## 功能特性

- ✅ 添加/编辑/删除订阅
- ✅ 支持多种周期：每日/每周/每月/每年/指定日期
- ✅ Telegram Bot 自动通知
- ✅ 管理员密码保护
- ✅ 响应式 Web 管理界面
- ✅ 数据库自动初始化

## 项目结构

```
├── src/
│   └── worker.js      # Worker 主程序（包含前端HTML）
├── wrangler.toml      # Cloudflare 配置
├── .gitignore         # Git 忽略规则
└── README.md          # 说明文档
```

## 部署步骤

### 1. 创建 D1 数据库

1. 登录 [Cloudflare Dashboard](https://dash.cloudflare.com)
2. 进入 **Workers & Pages** → **D1**
3. 点击 **Create database**
4. 名称输入：`subscription-db`
5. 创建完成，记住数据库（后续绑定用）

### 2. 推送代码到 GitHub

将代码推送到你的 GitHub 仓库。

### 3. 创建 Worker

1. 进入 **Workers & Pages**
2. 点击 **Create Application**
3. 选择 **Workers** → **Connect to Git**
4. 授权并选择你的 GitHub 仓库
5. 配置构建设置：

   | 设置 | 值 |
   |------|-----|
   | Build command | （留空） |
   | Deploy command | `npx wrangler deploy` |

6. 点击 **Save and Deploy**

### 4. 绑定 D1 数据库

1. 进入刚创建的 Worker
2. 点击 **Settings** → **Variables**
3. 找到 **D1 Database Bindings**
4. 点击 **Add binding**
5. 填写：
   - Variable name: `DB`
   - D1 database: 选择 `subscription-db`
6. 点击 **Save**

### 5. 设置环境变量（Secrets）

在同一页面的 **Environment Variables** 部分：

1. 点击 **Add variable**
2. 添加以下变量（每个都要点击 **Encrypt** 加密）：

| 变量名 | 说明 |
|--------|------|
| `ADMIN_PASSWORD` | 管理员登录密码 |
| `TELEGRAM_BOT_TOKEN` | Telegram Bot Token |
| `TELEGRAM_CHAT_ID` | Telegram Chat ID |

### 6. 配置 Telegram Webhook

部署完成后，访问以下 URL 设置 Webhook：

```
https://api.telegram.org/bot<你的TOKEN>/setWebhook?url=https://<你的Worker域名>/webhook/telegram
```

将 `<你的TOKEN>` 替换为 Bot Token，`<你的Worker域名>` 替换为 Worker 的域名（如 `subscription-notifier.xxx.workers.dev`）。

## Telegram Bot 命令

| 命令 | 说明 |
|------|------|
| `/start` | 显示欢迎信息 |
| `/help` | 显示帮助 |
| `/list` | 查看所有订阅 |
| `/today` | 查看今日待通知 |

## 周期类型说明

| 类型 | 说明 | 值示例 |
|------|------|--------|
| `daily` | 每天 | 无需填写 |
| `weekly` | 每周 | 1-7 (周一到周日) |
| `monthly` | 每月 | 1-31 (日期) |
| `yearly` | 每年 | MM-DD (如 12-25) |
| `specific` | 指定日期 | YYYY-MM-DD |

## 访问面板

部署完成后，访问 Worker 域名即可：

```
https://subscription-notifier.<你的子域>.workers.dev
```

如果设置了 `ADMIN_PASSWORD`，需要输入密码登录。

## 本地开发

```bash
# 安装依赖
npm install

# 创建 .dev.vars 文件（本地环境变量）
# ADMIN_PASSWORD=你的密码
# TELEGRAM_BOT_TOKEN=你的Token
# TELEGRAM_CHAT_ID=你的ChatID

# 启动开发服务器
npx wrangler dev
```

## 注意事项

1. 所有敏感配置都在 Cloudflare Dashboard 设置，不要提交到 GitHub
2. 数据库会在首次访问时自动初始化
3. 如果未设置 `ADMIN_PASSWORD`，面板将无需密码直接访问
4. Worker 域名格式：`<项目名>.<子域>.workers.dev`

## 许可证

MIT