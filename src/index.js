import { Hono } from 'hono';
import { cors } from 'hono/cors';
import { serveStatic } from 'hono/cloudflare-workers';
import { handleTelegramWebhook } from './telegram-bot.js';

const app = new Hono();

// 启用CORS
app.use('*', cors());

// Telegram Bot Webhook
app.post('/webhook/telegram', async (c) => {
    return handleTelegramWebhook(c.req.raw, c.env);
});

// API路由
app.route('/api', createApiRouter());

// 前端静态文件
app.get('*', serveStatic({ root: './' }));

export default app;

function createApiRouter() {
    const api = new Hono();

    // 获取所有订阅
    api.get('/subscriptions', async (c) => {
        const db = c.env.DB;
        const { results } = await db.prepare(
            'SELECT * FROM subscriptions ORDER BY next_notify_date ASC'
        ).all();
        return c.json(results);
    });

    // 获取单个订阅
    api.get('/subscriptions/:id', async (c) => {
        const db = c.env.DB;
        const id = c.req.param('id');
        const { results } = await db.prepare(
            'SELECT * FROM subscriptions WHERE id = ?'
        ).bind(id).all();
        
        if (results.length === 0) {
            return c.json({ error: '订阅不存在' }, 404);
        }
        return c.json(results[0]);
    });

    // 创建订阅
    api.post('/subscriptions', async (c) => {
        const db = c.env.DB;
        const body = await c.req.json();
        
        const { name, content, cycle_type, cycle_value } = body;
        
        if (!name || !cycle_type) {
            return c.json({ error: '名称和周期类型为必填项' }, 400);
        }

        const nextNotifyDate = calculateNextNotifyDate(cycle_type, cycle_value);
        
        const { success } = await db.prepare(
            `INSERT INTO subscriptions (name, content, cycle_type, cycle_value, next_notify_date) 
             VALUES (?, ?, ?, ?, ?)`
        ).bind(name, content || '', cycle_type, cycle_value || '', nextNotifyDate).run();

        if (success) {
            return c.json({ success: true, message: '订阅创建成功' }, 201);
        }
        return c.json({ error: '创建失败' }, 500);
    });

    // 更新订阅
    api.put('/subscriptions/:id', async (c) => {
        const db = c.env.DB;
        const id = c.req.param('id');
        const body = await c.req.json();
        
        const { name, content, cycle_type, cycle_value, is_active } = body;
        
        const nextNotifyDate = cycle_type ? 
            calculateNextNotifyDate(cycle_type, cycle_value) : undefined;

        let query = 'UPDATE subscriptions SET updated_at = datetime(\'now\')';
        const params = [];

        if (name !== undefined) { query += ', name = ?'; params.push(name); }
        if (content !== undefined) { query += ', content = ?'; params.push(content); }
        if (cycle_type !== undefined) { query += ', cycle_type = ?'; params.push(cycle_type); }
        if (cycle_value !== undefined) { query += ', cycle_value = ?'; params.push(cycle_value); }
        if (nextNotifyDate) { query += ', next_notify_date = ?'; params.push(nextNotifyDate); }
        if (is_active !== undefined) { query += ', is_active = ?'; params.push(is_active ? 1 : 0); }

        query += ' WHERE id = ?';
        params.push(id);

        const { success } = await db.prepare(query).bind(...params).run();

        if (success) {
            return c.json({ success: true, message: '更新成功' });
        }
        return c.json({ error: '更新失败' }, 500);
    });

    // 删除订阅
    api.delete('/subscriptions/:id', async (c) => {
        const db = c.env.DB;
        const id = c.req.param('id');
        
        const { success } = await db.prepare(
            'DELETE FROM subscriptions WHERE id = ?'
        ).bind(id).run();

        if (success) {
            return c.json({ success: true, message: '删除成功' });
        }
        return c.json({ error: '删除失败' }, 500);
    });

    // 手动触发通知
    api.post('/notify', async (c) => {
        const db = c.env.DB;
        const env = c.env;
        
        const result = await checkAndSendNotifications(db, env);
        return c.json(result);
    });

    // 获取通知历史
    api.get('/notifications', async (c) => {
        const db = c.env.DB;
        const { results } = await db.prepare(
            `SELECT n.*, s.name as subscription_name 
             FROM notifications n 
             JOIN subscriptions s ON n.subscription_id = s.id 
             ORDER BY n.sent_at DESC 
             LIMIT 100`
        ).all();
        return c.json(results);
    });

    return api;
}

// 计算下次通知日期
function calculateNextNotifyDate(cycleType, cycleValue) {
    const now = new Date();
    let nextDate = new Date();

    switch (cycleType) {
        case 'daily':
            nextDate.setDate(now.getDate() + 1);
            break;
            
        case 'weekly':
            const targetDay = parseInt(cycleValue) || 1; // 1=周一, 7=周日
            const currentDay = now.getDay() || 7;
            const daysUntilTarget = (targetDay - currentDay + 7) % 7 || 7;
            nextDate.setDate(now.getDate() + daysUntilTarget);
            break;
            
        case 'monthly':
            const targetMonthDay = parseInt(cycleValue) || 1;
            nextDate.setDate(targetMonthDay);
            if (nextDate <= now) {
                nextDate.setMonth(nextDate.getMonth() + 1);
            }
            break;
            
        case 'yearly':
            const [month, day] = (cycleValue || '1-1').split('-').map(Number);
            nextDate.setMonth(month - 1, day);
            if (nextDate <= now) {
                nextDate.setFullYear(nextDate.getFullYear() + 1);
            }
            break;
            
        case 'specific':
            // cycleValue格式: YYYY-MM-DD
            nextDate = new Date(cycleValue);
            if (nextDate <= now) {
                // 如果指定日期已过，设为明年同一天
                nextDate.setFullYear(nextDate.getFullYear() + 1);
            }
            break;
    }

    return nextDate.toISOString().split('T')[0];
}

// 检查并发送通知
async function checkAndSendNotifications(db, env) {
    const today = new Date().toISOString().split('T')[0];
    
    const { results: dueSubscriptions } = await db.prepare(
        `SELECT * FROM subscriptions 
         WHERE next_notify_date <= ? AND is_active = 1`
    ).bind(today).all();

    const sentNotifications = [];

    for (const sub of dueSubscriptions) {
        try {
            // 发送Telegram通知
            await sendTelegramNotification(env, sub);
            
            // 记录通知
            await db.prepare(
                'INSERT INTO notifications (subscription_id, status) VALUES (?, ?)'
            ).bind(sub.id, 'success').run();

            // 更新下次通知日期
            const nextDate = calculateNextNotifyDate(sub.cycle_type, sub.cycle_value);
            await db.prepare(
                'UPDATE subscriptions SET next_notify_date = ? WHERE id = ?'
            ).bind(nextDate, sub.id).run();

            sentNotifications.push({ id: sub.id, name: sub.name, status: 'success' });
        } catch (error) {
            await db.prepare(
                'INSERT INTO notifications (subscription_id, status) VALUES (?, ?)'
            ).bind(sub.id, 'failed: ' + error.message).run();

            sentNotifications.push({ id: sub.id, name: sub.name, status: 'failed', error: error.message });
        }
    }

    return {
        checked: dueSubscriptions.length,
        sent: sentNotifications.length,
        details: sentNotifications
    };
}

// 发送Telegram通知
async function sendTelegramNotification(env, subscription) {
    const botToken = env.TELEGRAM_BOT_TOKEN;
    const chatId = env.TELEGRAM_CHAT_ID;

    if (!botToken || !chatId) {
        throw new Error('Telegram配置缺失');
    }

    const message = `🔔 *订阅到期提醒*\n\n` +
        `📌 *名称*: ${subscription.name}\n` +
        `📝 *内容*: ${subscription.content || '无'}\n` +
        `📅 *周期*: ${getCycleLabel(subscription.cycle_type, subscription.cycle_value)}\n` +
        `⏰ *下次通知*: ${subscription.next_notify_date}\n\n` +
        `_发送于 ${new Date().toLocaleString('zh-CN')}_`;

    const url = `https://api.telegram.org/bot${botToken}/sendMessage`;
    
    const response = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
            chat_id: chatId,
            text: message,
            parse_mode: 'Markdown'
        })
    });

    if (!response.ok) {
        const error = await response.json();
        throw new Error(`Telegram API错误: ${error.description}`);
    }

    return await response.json();
}

// 获取周期标签
function getCycleLabel(cycleType, cycleValue) {
    const labels = {
        'daily': '每日',
        'weekly': `每周${getDayName(parseInt(cycleValue) || 1)}`,
        'monthly': `每月${cycleValue || 1}日`,
        'yearly': `每年${cycleValue || '1-1'}`,
        'specific': `指定日期: ${cycleValue}`
    };
    return labels[cycleType] || cycleType;
}

// 获取星期名称
function getDayName(day) {
    const days = ['', '一', '二', '三', '四', '五', '六', '日'];
    return days[day] || '';
}