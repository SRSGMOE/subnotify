# 订阅到期通知面板

基于 Cloudflare Workers + D1 数据库的订阅管理系统，支持 Telegram Bot 通知。

## 功能特性

- ✅ 添加/编辑/删除订阅
- ✅ 支持多种周期：每日/每周/每月/每年/指定日期
- ✅ 通知时间精确到分钟（10分钟间隔：00/10/20/30/40/50）
- ✅ 支持多时区：世界时间(UTC)、北京时间(CST)、美国东部(ET)
- ✅ 自定义通知标题
- ✅ Telegram Bot 自动通知
- ✅ Telegram Bot 命令管理（/start /help /list /today /status）
- ✅ 管理员密码保护
- ✅ 响应式 Web 管理界面
- ✅ 数据库自动初始化
- ✅ 服务器时间校准（防止用户设备时间错误）
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
- **内容**：订阅详情说明（必填，支持换行）
- **周期类型**：每日/每周/每月/每年/指定日期
- **周期值**：根据类型不同（如每周几、每月几号等）
- **通知时间**：小时（0-23）和分钟（00/10/20/30/40/50）
- **时区**：UTC/CST(北京时间)/ET(美国东部)

### 通知设置

- **自定义通知标题**：可修改 Telegram 通知的标题（默认：订阅到期提醒）
- **实时预览**：编辑时可预览通知效果

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
- 自定义标题（可在面板设置）
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
3. 添加两个任务：
   - `*/10 * * * *`（每10分钟检查通知）
   - `* * * * *`（每1分钟时间同步）
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
- 世界协调时 UTC（实时显示，服务器时间校准）
- 北京时间 CST（实时显示）
- 美国东部 ET（实时显示）

### 用户提示
- 提醒用户确保设备时间准确

### 操作卡片
- **添加订阅**：创建新的订阅通知
- **编辑通知**：自定义通知标题
- **测试通知**：测试 Telegram Bot 连接

### 订阅列表
- 序号
- 名称
- 内容（支持多行显示）
- 周期（如：每日、每周五、每月15日、每年12月25日）
- 时区（世界时间/UTC、北京时间/CST、美国时间/ET）
- 下次通知（日期 + 时间）
- 状态（活跃/暂停）
- 操作（编辑/暂停/恢复/删除）

## 时间校准机制

### 问题

用户设备的时间可能不准确，导致面板显示错误的时间。

### 解决方案

面板使用**服务器时间校准**机制：

1. 首次加载时从服务器获取时间
2. 计算服务器时间与本地时间的差值（偏移量）
3. 后续显示时间 = 本地时间 + 偏移量
4. 每5分钟自动重新校准

### 校准流程

```
首次加载 → 请求服务器时间 → 计算偏移量 → 显示校准后的时间
    ↓
每5分钟 → 重新校准 → 更新偏移量
```

### 请求消耗

| 类型 | 频率 | 每天消耗 |
|------|------|---------|
| 首次校准 | 页面加载时 | 1 次 |
| 定期校准 | 每5分钟 | 288 次 |
| **总计** | - | ~289 次 |

> 💡 即使用户设备时间错误，面板也会显示正确的服务器时间。

## Cron 定时任务

面板使用 Cloudflare Workers 的 Cron 触发器执行定时任务。

### 任务列表

| Cron 表达式 | 频率 | 用途 | 每天消耗 |
|------------|------|------|---------|
| `*/10 * * * *` | 每10分钟 | 检查并发送通知 | 144 次 |
| `* * * * *` | 每1分钟 | 服务器时间同步 | 1,440 次 |

### 任务说明

#### 1. 通知检查（每10分钟）
- 检查数据库中的到期订阅
- 通过 Telegram Bot 发送通知
- 更新下次通知日期

#### 2. 时间同步（每1分钟）
- 同步服务器时间
- 确保面板时间显示准确
- 即使用户关闭浏览器也会持续运行

### 修改 Cron 频率

编辑 `wrangler.toml` 文件：

```toml
[triggers]
crons = ["*/10 * * * *", "* * * * *"]
```

### 请求消耗

| 任务 | 频率 | 每天消耗 | 占免费配额 |
|------|------|---------|-----------|
| 通知检查 | 每10分钟 | 144 次 | 0.14% |
| 时间同步 | 每1分钟 | 1,440 次 | 1.44% |
| **总计** | - | **1,584 次** | **1.58%** |

> 💡 前端面板的时间显示使用客户端 JavaScript 计算，实时更新，不消耗 Workers 请求。

## 数据库结构

### subscriptions 表（订阅）

| 字段 | 类型 | 说明 |
|------|------|------|
| id | INTEGER | 主键 |
| name | TEXT | 名称（必填） |
| content | TEXT | 内容（必填） |
| cycle_type | TEXT | 周期类型 |
| cycle_value | TEXT | 周期值 |
| cycle_hour | TEXT | 小时（00-23） |
| cycle_minute | TEXT | 分钟（00/10/20/30/40/50） |
| timezone | TEXT | 时区（UTC/CST/ET） |
| next_notify_date | TEXT | 下次通知日期 |
| is_active | INTEGER | 是否激活（1/0） |

### notify_settings 表（通知设置）

| 字段 | 类型 | 说明 |
|------|------|------|
| id | INTEGER | 主键 |
| key | TEXT | 设置键名 |
| value | TEXT | 设置值 |

## API 接口

| 接口 | 方法 | 说明 | 认证 |
|------|------|------|------|
| `/api/auth/status` | GET | 检查是否需要认证 | ❌ |
| `/api/login` | POST | 登录 | ❌ |
| `/api/auth/verify` | POST | 验证 token | ❌ |
| `/api/server-time` | GET | 获取服务器时间 | ❌ |
| `/api/subscriptions` | GET | 获取订阅列表 | ✅ |
| `/api/subscriptions` | POST | 创建订阅 | ✅ |
| `/api/subscriptions/:id` | PUT | 更新订阅 | ✅ |
| `/api/subscriptions/:id` | DELETE | 删除订阅 | ✅ |
| `/api/notify` | POST | 手动触发通知 | ✅ |
| `/api/test-telegram` | POST | 测试 Telegram | ✅ |
| `/api/notify-settings` | GET | 获取通知设置 | ✅ |
| `/api/notify-settings` | POST | 保存通知设置 | ✅ |
| `/webhook/telegram` | POST | Telegram Webhook | ❌ |

## 访问面板

部署完成后，访问 Worker 域名：
```
https://subscription-notifier.<你的子域>.workers.dev
```

如果设置了 `ADMIN_PASSWORD`，需要输入密码登录。

## 常见问题

### Q: 部署后显示 520 错误？

A: 检查 Worker 日志（Settings → Observability → Logs），通常是代码语法错误。

### Q: 数据库报错 "DB not bound"？

A: 确认 D1 Database Bindings 已正确配置，变量名必须是 `DB`。

### Q: 无法登录？

A: 确认已设置 `ADMIN_PASSWORD` 环境变量。

### Q: Telegram Bot 不发送通知？

A: 检查：
1. `TELEGRAM_BOT_TOKEN` 和 `TELEGRAM_CHAT_ID` 是否正确
2. 是否已向 Bot 发送过消息
3. Webhook 是否设置成功
4. Cron Trigger 是否配置

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