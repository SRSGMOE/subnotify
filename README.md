# 订阅到期通知面板

基于 Cloudflare Workers + D1 数据库的订阅管理系统，支持 Telegram Bot 通知。

## 功能特性

- ✅ 添加/编辑/删除订阅
- ✅ 支持多种周期：每日/每周/每月/每年/指定日期
- ✅ 通知时间精确到分钟（10分钟间隔：00/10/20/30/40/50）
- ✅ 支持多时区：世界时间(UTC)、北京时间(CST)、美国东部(ET)
- ✅ Telegram Bot 自动通知
- ✅ Telegram Bot 命令管理（/start /help /list /today /status）
- ✅ 管理员密码保护
- ✅ 响应式 Web 管理界面
- ✅ 数据库自动初始化
- ✅ 定时自动检查通知（每10分钟）

## 项目结构

```
├── src/
│   └── worker.js      # Worker 主程序（包含前端HTML和API）
├── wrangler.toml      # Cloudflare 配置文件
├── package.json       # 项目配置
├── .gitignore         # Git 忽略规则
└── README.md          # 说明文档
```

## 功能说明

### 订阅管理

每个订阅包含以下信息：
- **名称**：订阅标题（必填）
- **内容**：订阅详情说明（必填）
- **周期类型**：每日/每周/每月/每年/指定日期
- **周期值**：根据类型不同（如每周几、每月几号等）
- **通知时间**：小时（0-23）和分钟（00/10/20/30/40/50）
- **时区**：UTC/CST(北京时间)/ET(美国东部)

### 时区说明

| 时区代码 | 显示名称 | UTC偏移 |
|---------|---------|---------|
| UTC | 世界时间/UTC | +0 |
| CST | 北京时间/CST | +8 |
| ET | 美国时间/ET | -4 |

### 周期类型

| 类型 | 说明 | 值示例 |
|------|------|--------|
| daily | 每天 | 无需填写 |
| weekly | 每周 | 1-7 (周一到周日) |
| monthly | 每月 | 1-28 (日期) |
| yearly | 每年 | MM-DD (如 12-25) |
| specific | 指定日期 | YYYY-MM-DD |

### Telegram Bot 通知内容

通知消息包含：
- 名称
- 内容
- 周期
- 时区
- 下次通知时间（显示下一个周期的日期和时间）

## 部署步骤（Cloudflare Workers + GitHub）

### 第一步：创建 D1 数据库

1. 登录 [Cloudflare Dashboard](https://dash.cloudflare.com)
2. 在左侧菜单找到 **Workers & Pages**
3. 点击 **D1** 标签
4. 点击 **Create database**
5. 数据库名称输入：`subscription-db`
6. 点击 **Create**

### 第二步：推送代码到 GitHub

1. 在 GitHub 创建新仓库
2. 将项目文件推送到仓库

### 第三步：创建 Cloudflare Worker

1. 在 Cloudflare Dashboard 进入 **Workers & Pages**
2. 点击 **Create Application**
3. 选择 **Workers** → **Connect to Git**
4. 选择你的 GitHub 仓库
5. 构建配置：
   - **Build command**: （留空）
   - **Deploy command**: `npx wrangler deploy`
6. 点击 **Save and Deploy**

### 第四步：绑定 D1 数据库

1. 进入 Worker → **Settings** → **Variables**
2. 找到 **D1 Database Bindings**
3. 点击 **Add binding**
4. 填写：
   - **Variable name**: `DB`
   - **D1 database**: 选择 `subscription-db`
5. 点击 **Save**

### 第五步：设置环境变量（Secrets）

在 Worker → **Settings** → **Variables** 的 **Environment Variables** 部分：

添加以下变量（每个都要点击 **Encrypt** 加密）：

| 变量名 | 说明 |
|--------|------|
| `ADMIN_PASSWORD` | 管理员登录密码 |
| `TELEGRAM_BOT_TOKEN` | Telegram Bot Token |
| `TELEGRAM_CHAT_ID` | 接收通知的 Chat ID |

### 第六步：配置 Telegram Bot

#### 6.1 创建 Bot（如果还没有）

1. 在 Telegram 搜索 `@BotFather`
2. 发送 `/newbot`
3. 按提示输入 Bot 名称和用户名
4. 记录返回的 **Bot Token**

#### 6.2 获取 Chat ID

1. 在 Telegram 找到你的 Bot
2. 向 Bot 发送任意消息（如 `/start`）
3. 访问：`https://api.telegram.org/bot<你的TOKEN>/getUpdates`
4. 在返回的 JSON 中找到 `chat.id` 字段

#### 6.3 设置 Webhook

访问以下 URL（替换 TOKEN 和域名）：
```
https://api.telegram.org/bot<你的TOKEN>/setWebhook?url=https://<你的Worker域名>/webhook/telegram
```

### 第七步：设置定时触发器

1. 进入 Worker → **Settings** → **Triggers**
2. 找到 **Cron Triggers**
3. 添加：`*/10 * * * *`（每10分钟检查一次）
4. 点击 **Save**

## Telegram Bot 命令

| 命令 | 说明 |
|------|------|
| `/start` | 开始使用，显示欢迎信息 |
| `/help` | 查看帮助和可用命令 |
| `/list` | 查看所有订阅列表（显示名称、时间、时区） |
| `/today` | 查看今日待通知 |
| `/status` | 查看系统状态（世界时钟/北京时间/美国东部） |

## 面板功能

### 时间卡片
- 世界协调时 UTC（实时显示）
- 北京时间 CST（实时显示）
- 美国东部 ET（实时显示）

### 操作卡片
- **添加订阅**：创建新的订阅通知
- **立即通知**：手动触发通知检查
- **测试通知**：测试 Telegram Bot 连接

### 订阅列表
- 序号
- 名称
- 周期（如：每日、每周五、每月15日、每年12月25日）
- 时区（世界时间/UTC、北京时间/CST、美国时间/ET）
- 下次通知（日期 + 时间）
- 状态（活跃/暂停）
- 操作（编辑/暂停/恢复/删除）

## 访问面板

部署完成后，访问 Worker 域名：
```
https://subscription-notifier.<你的子域>.workers.dev
```

如果设置了 `ADMIN_PASSWORD`，需要输入密码登录。

## 常见问题

### Q: 部署后显示 520 错误？

A: 检查 Worker 日志（Settings → Logs），通常是代码语法错误。

### Q: 数据库报错 "DB not bound"？

A: 确认 D1 Database Bindings 已正确配置，变量名必须是 `DB`。

### Q: 无法登录？

A: 确认已设置 `ADMIN_PASSWORD` 环境变量。

### Q: Telegram Bot 不发送通知？

A: 检查：
1. `TELEGRAM_BOT_TOKEN` 和 `TELEGRAM_CHAT_ID` 是否正确
2. 是否已向 Bot 发送过消息
3. Webhook 是否设置成功
4. Cron Trigger 是否配置为 `*/10 * * * *`

### Q: 通知时间不准确？

A: 确认订阅的时区设置正确。北京时间应选择 `CST`。

### Q: 如何查看 Worker 日志？

A: Worker → Settings → Observability → Logs

## 本地开发

```bash
# 安装依赖
npm install

# 创建本地环境变量文件 .dev.vars
# ADMIN_PASSWORD=你的密码
# TELEGRAM_BOT_TOKEN=你的Token
# TELEGRAM_CHAT_ID=你的ChatID

# 启动本地开发服务器
npx wrangler dev
```

## 技术栈

- **Runtime**: Cloudflare Workers
- **Database**: Cloudflare D1 (SQLite)
- **Frontend**: Vue 3 (CDN)
- **Bot**: Telegram Bot API

## 许可证

MIT