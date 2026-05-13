-- 订阅通知表
CREATE TABLE IF NOT EXISTS subscriptions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    content TEXT,
    cycle_type TEXT NOT NULL CHECK(cycle_type IN ('daily', 'weekly', 'monthly', 'yearly', 'specific')),
    cycle_value TEXT,
    next_notify_date TEXT NOT NULL,
    created_at TEXT DEFAULT (datetime('now')),
    updated_at TEXT DEFAULT (datetime('now')),
    is_active INTEGER DEFAULT 1
);

-- 通知记录表
CREATE TABLE IF NOT EXISTS notifications (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    subscription_id INTEGER NOT NULL,
    sent_at TEXT DEFAULT (datetime('now')),
    status TEXT DEFAULT 'success',
    FOREIGN KEY (subscription_id) REFERENCES subscriptions(id)
);

-- 创建索引
CREATE INDEX IF NOT EXISTS idx_subscriptions_next_notify ON subscriptions(next_notify_date);
CREATE INDEX IF NOT EXISTS idx_subscriptions_active ON subscriptions(is_active);