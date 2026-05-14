// Cloudflare Worker - 订阅通知面板

export default {
    async fetch(request, env) {
        const url = new URL(request.url);
        const path = url.pathname;
        
        const corsHeaders = {
            'Access-Control-Allow-Origin': '*',
            'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS',
            'Access-Control-Allow-Headers': 'Content-Type, Authorization',
        };
        
        if (request.method === 'OPTIONS') {
            return new Response(null, { headers: corsHeaders });
        }
        
        try {
            // 首页
            if (path === '/' || path === '/index.html') {
                return new Response(getHTML(), { 
                    headers: { 'Content-Type': 'text/html;charset=utf-8' } 
                });
            }
            
            // API路由
            if (path.startsWith('/api/')) {
                const apiPath = path.replace('/api', '') || '/';
                const response = await handleAPI(request, env, apiPath);
                const newResponse = new Response(response.body, response);
                Object.entries(corsHeaders).forEach(([k, v]) => newResponse.headers.set(k, v));
                if (!newResponse.headers.get('Content-Type')) {
                    newResponse.headers.set('Content-Type', 'application/json');
                }
                return newResponse;
            }
            
            // Telegram Webhook
            if (path === '/webhook/telegram') {
                return handleTelegram(request, env);
            }
            
            return new Response('Not Found', { status: 404 });
        } catch (error) {
            return new Response(JSON.stringify({ error: error.message }), {
                status: 500,
                headers: { ...corsHeaders, 'Content-Type': 'application/json' }
            });
        }
        },
    
    // 定时任务处理
    async scheduled(event, env, ctx) {
        ctx.waitUntil(checkAndSendNotifications(env));
    }
};



// 定时检查并发送通知
async function checkAndSendNotifications(env) {
    if (!env.DB || !env.TELEGRAM_BOT_TOKEN || !env.TELEGRAM_CHAT_ID) {
        return;
    }
    
    try {
        await initDB(env.DB);
        
        const now = new Date();
        const today = now.toISOString().split('T')[0];
        const currentUTCHour = now.getUTCHours();
        
        // 获取所有活跃订阅
        const { results } = await env.DB.prepare(
            'SELECT * FROM subscriptions WHERE is_active=1'
        ).all();
        
        for (const sub of results) {
            try {
                // 计算订阅时区的当前本地时间
                const offsets = { 'UTC': 0, 'CST': 8, 'ET': -4 };
                const subOffset = offsets[sub.timezone] || 0;
                
                // 获取订阅时区的当前日期和时间
                const subLocalTime = new Date(now.getTime() + subOffset * 3600000);
                const subLocalDate = subLocalTime.toISOString().split('T')[0];
                const subLocalHour = subLocalTime.getUTCHours();
                const subLocalMinute = subLocalTime.getUTCMinutes();
                
                const cycleHour = parseInt(sub.cycle_hour || '09');
                const cycleMinute = parseInt(sub.cycle_minute || '00');
                
                // 比较日期
                if (sub.next_notify_date > subLocalDate) {
                    continue; // 还没到日期
                }
                
                // 如果是当天，比较时间
                if (sub.next_notify_date === subLocalDate) {
                    const currentTotalMinutes = subLocalHour * 60 + subLocalMinute;
                    const cycleTotalMinutes = cycleHour * 60 + cycleMinute;
                    
                    if (currentTotalMinutes < cycleTotalMinutes) {
                        continue; // 时间未到
                    }
                }
                
                // 先计算下一个通知日期
                let nextDate = sub.next_notify_date;
                if (sub.cycle_type !== 'specific') {
                    nextDate = calculateNextDate(sub.cycle_type, sub.cycle_value, sub.cycle_hour, sub.timezone, sub.next_notify_date);
                }
                
                // 发送通知（传入下一个日期）
                await sendTelegramMessage(env, sub, nextDate);
                
                // 指定日期通知完成后自动暂停
                if (sub.cycle_type === 'specific') {
                    await env.DB.prepare('UPDATE subscriptions SET is_active=0 WHERE id=?').bind(sub.id).run();
                    console.log('一次性通知已发送并暂停:', sub.name);
                } else {
                    await env.DB.prepare('UPDATE subscriptions SET next_notify_date=? WHERE id=?').bind(nextDate, sub.id).run();
                    console.log('通知已发送:', sub.name, '下次通知:', nextDate);
                }
            } catch (e) {
                console.error('发送通知失败:', sub.name, e);
            }
        }
        
        if (results.length > 0) {
            console.log('定时任务完成，发送了', results.length, '条通知');
        }
    } catch (e) {
        console.error('定时任务错误:', e);
    }
}

// 处理API请求
async function handleAPI(request, env, path) {
    const method = request.method;
    const json = (data, status) => new Response(JSON.stringify(data), { status: status || 200 });
    
    // 检查数据库绑定
    if (!env.DB) {
        return json({ error: '数据库未绑定，请在Settings -> Variables -> D1 Database Bindings中绑定' }, 500);
    }
    
    // 初始化数据库
    await initDB(env.DB);
    
    // 认证相关（不需要密码）
    if (path === '/auth/status') {
        return json({ requireAuth: !!env.ADMIN_PASSWORD });
    }
    
    if (path === '/login' && method === 'POST') {
        const body = await request.json();
        if (!env.ADMIN_PASSWORD) {
            return json({ success: true, token: 'no-auth' });
        }
        if (body.password === env.ADMIN_PASSWORD) {
            return json({ success: true, token: generateToken(env.ADMIN_PASSWORD) });
        }
        return json({ success: false, error: '密码错误' }, 401);
    }
    
    if (path === '/auth/verify' && method === 'POST') {
        const body = await request.json();
        if (!env.ADMIN_PASSWORD) {
            return json({ valid: true });
        }
        return json({ valid: body.token === generateToken(env.ADMIN_PASSWORD) });
    }
    
    if (path === '/server-time') {
        const now = new Date();
        return json({
            utc: formatDateTime(now, 0),
            cst: formatDateTime(now, 8),
            et: formatDateTime(now, -4)
        });
    }
    
    // 需要认证的接口
    if (env.ADMIN_PASSWORD) {
        const authHeader = request.headers.get('Authorization');
        const token = authHeader ? authHeader.replace('Bearer ', '') : '';
        if (token !== generateToken(env.ADMIN_PASSWORD)) {
            return json({ error: '未授权' }, 401);
        }
    }
    
    // 测试Telegram
    if (path === '/test-telegram' && method === 'POST') {
        try {
            const res = await fetch('https://api.telegram.org/bot' + env.TELEGRAM_BOT_TOKEN + '/sendMessage', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    chat_id: env.TELEGRAM_CHAT_ID,
                    text: 'Bot已连接！发送 /help 或 /start 查看命令'
                })
            });
            const data = await res.json();
            return json({ success: data.ok, message: data.description });
        } catch (error) {
            return json({ success: false, error: error.message });
        }
    }
    
    // 订阅CRUD
    if (path === '/subscriptions' && method === 'GET') {
        const { results } = await env.DB.prepare('SELECT * FROM subscriptions ORDER BY next_notify_date').all();
        return json(results);
    }
    
    if (path === '/subscriptions' && method === 'POST') {
        const body = await request.json();
        if (!body.name || !body.content || !body.cycle_type || !body.timezone) {
            return json({ error: '所有字段必填' }, 400);
        }
        const nextDate = calculateNextDate(body.cycle_type, body.cycle_value, body.cycle_hour + ':' + (body.cycle_minute || '00'), body.timezone, null, true);
        console.log('创建订阅:', body.name, '类型:', body.cycle_type, '时间:', body.cycle_hour + ':' + body.cycle_minute, '计算结果:', nextDate);
        await env.DB.prepare(
            'INSERT INTO subscriptions (name,content,cycle_type,cycle_value,cycle_hour,cycle_minute,timezone,next_notify_date) VALUES (?,?,?,?,?,?,?,?)'
        ).bind(body.name, body.content, body.cycle_type, body.cycle_value || '', body.cycle_hour || '09', body.cycle_minute || '00', body.timezone || 'UTC', nextDate).run();
        return json({ success: true }, 201);
    }
    
    // 单个订阅操作
    const subMatch = path.match(/^\/subscriptions\/(\d+)$/);
    if (subMatch) {
        const id = subMatch[1];
        
        if (method === 'GET') {
            const { results } = await env.DB.prepare('SELECT * FROM subscriptions WHERE id=?').bind(id).all();
            return results.length ? json(results[0]) : json({ error: '不存在' }, 404);
        }
        
        if (method === 'PUT') {
            const body = await request.json();
            let sql = "UPDATE subscriptions SET updated_at=datetime('now')";
            const params = [];
            
            if (body.name !== undefined) { sql += ',name=?'; params.push(body.name); }
            if (body.content !== undefined) { sql += ',content=?'; params.push(body.content); }
            if (body.cycle_type !== undefined) { sql += ',cycle_type=?'; params.push(body.cycle_type); }
            if (body.cycle_value !== undefined) { sql += ',cycle_value=?'; params.push(body.cycle_value); }
            if (body.cycle_hour !== undefined) { sql += ',cycle_hour=?'; params.push(body.cycle_hour); }
            if (body.cycle_minute !== undefined) { sql += ',cycle_minute=?'; params.push(body.cycle_minute); }
            if (body.timezone !== undefined) { sql += ',timezone=?'; params.push(body.timezone); }
            if (body.is_active !== undefined) { sql += ',is_active=?'; params.push(body.is_active ? 1 : 0); }
            if (body.cycle_type) {
                sql += ',next_notify_date=?';
                params.push(calculateNextDate(body.cycle_type, body.cycle_value, body.cycle_hour + ':' + (body.cycle_minute || '00'), body.timezone, null, true));
            }
            
            sql += ' WHERE id=?';
            params.push(id);
            
            await env.DB.prepare(sql).bind(...params).run();
            return json({ success: true });
        }
        
        if (method === 'DELETE') {
            await env.DB.prepare('DELETE FROM subscriptions WHERE id=?').bind(id).run();
            return json({ success: true });
        }
    }
    
    // 触发通知
    if (path === '/notify' && method === 'POST') {
        const now = new Date();
        const today = now.toISOString().split('T')[0];
        const currentUTCHour = now.getUTCHours();
        
        // 获取所有到期的订阅（不比较小时，因为有时区差异）
        const { results } = await env.DB.prepare(
            'SELECT * FROM subscriptions WHERE next_notify_date<=? AND is_active=1'
        ).bind(today).all();
        
        let sent = 0;
        for (const sub of results) {
            try {
                // 先计算下一个通知日期
                const nextDate = calculateNextDate(sub.cycle_type, sub.cycle_value, sub.cycle_hour + ':' + (sub.cycle_minute || '00'), sub.timezone, sub.next_notify_date);
                
                if (env.TELEGRAM_BOT_TOKEN && env.TELEGRAM_CHAT_ID) {
                    await sendTelegramMessage(env, sub, nextDate);
                }
                await env.DB.prepare('UPDATE subscriptions SET next_notify_date=? WHERE id=?').bind(nextDate, sub.id).run();
                sent++;
            } catch (e) {
                console.error('发送通知失败:', e);
            }
        }
        
        return json({ checked: results.length, sent: sent });
    }
    
    return json({ error: '未找到路由' }, 404);
}

// 初始化数据库
async function initDB(db) {
    try {
        const { results } = await db.prepare(
            "SELECT name FROM sqlite_master WHERE type='table' AND name='subscriptions'"
        ).all();
        
        if (results.length === 0) {
            await db.exec(`
                CREATE TABLE IF NOT EXISTS subscriptions (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    name TEXT NOT NULL,
                    content TEXT NOT NULL,
                    cycle_type TEXT NOT NULL,
                    cycle_value TEXT,
                    cycle_hour TEXT DEFAULT '09',
                    timezone TEXT DEFAULT 'UTC',
                    next_notify_date TEXT NOT NULL,
                    created_at TEXT DEFAULT (datetime('now')),
                    updated_at TEXT DEFAULT (datetime('now')),
                    is_active INTEGER DEFAULT 1
                );
                CREATE TABLE IF NOT EXISTS notifications (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    subscription_id INTEGER NOT NULL,
                    sent_at TEXT DEFAULT (datetime('now')),
                    status TEXT DEFAULT 'success'
                );
            `);
        } else {
            // 检查并添加新字段
            const { results: columns } = await db.prepare("PRAGMA table_info(subscriptions)").all();
            const columnNames = columns.map(c => c.name);
            
            if (!columnNames.includes('cycle_hour')) {
                await db.exec("ALTER TABLE subscriptions ADD COLUMN cycle_hour TEXT DEFAULT '09'");
            }
            if (!columnNames.includes('cycle_minute')) {
                await db.exec("ALTER TABLE subscriptions ADD COLUMN cycle_minute TEXT DEFAULT '00'");
            }
            if (!columnNames.includes('timezone')) {
                await db.exec("ALTER TABLE subscriptions ADD COLUMN timezone TEXT DEFAULT 'UTC'");
            }
        }
    } catch (e) {
        console.error('数据库初始化错误:', e);
    }
}

// 生成Token
function generateToken(password) {
    let hash = 0;
    for (let i = 0; i < password.length; i++) {
        hash = ((hash << 5) - hash) + password.charCodeAt(i);
        hash = hash & hash;
    }
    return 'auth_' + Math.abs(hash).toString(36);
}

// 格式化日期时间
function formatDateTime(date, offsetHours) {
    const local = new Date(date.getTime() + offsetHours * 3600000);
    const year = local.getUTCFullYear();
    const month = String(local.getUTCMonth() + 1).padStart(2, '0');
    const day = String(local.getUTCDate()).padStart(2, '0');
    const hours = String(local.getUTCHours()).padStart(2, '0');
    const minutes = String(local.getUTCMinutes()).padStart(2, '0');
    const seconds = String(local.getUTCSeconds()).padStart(2, '0');
    return year + '-' + month + '-' + day + ' ' + hours + ':' + minutes + ':' + seconds;
}

// 计算下次通知日期
function calculateNextDate(type, value, hour, timezone, currentDate, isNew) {
    console.log('calculateNextDate 调用:', {type, value, hour, timezone, currentDate, isNew});
    hour = hour || '09';
    let minute = '00';
    if (hour && hour.includes(':')) {
        const parts = hour.split(':');
        hour = parts[0];
        minute = parts[1] || '00';
    }
    timezone = timezone || 'UTC';
    
    // 解析当前日期（本地日期）
    const now = new Date();
    const dateParts = (currentDate || now.toISOString().split('T')[0]).split('-');
    let year = parseInt(dateParts[0]);
    let month = parseInt(dateParts[1]) - 1; // 0-indexed
    let day = parseInt(dateParts[2]);
    
    // 获取当前本地时间
    const offsets = { 'UTC': 0, 'CST': 8, 'ET': -4 };
    const offset = offsets[timezone] || 0;
    const localNow = new Date(now.getTime() + offset * 3600000);
    const currentHour = localNow.getUTCHours();
    const currentMinute = localNow.getUTCMinutes();
    
    // 创建日期对象（使用UTC存储，但逻辑上是本地时间）
    let next = new Date(Date.UTC(year, month, day, parseInt(hour), parseInt(minute), 0));
    
    // 当前时间的总分钟数
    const currentTotalMinutes = currentHour * 60 + currentMinute;
    const targetTotalMinutes = parseInt(hour) * 60 + parseInt(minute);
    
    // 对于新订阅，检查今天是否还能触发
    console.log('isNew检查:', {isNew, type, value, targetTotalMinutes, currentTotalMinutes, year, month, day});
    if (isNew) {
        // 对于 weekly，需要检查今天是否是目标星期几
        if (type === 'weekly') {
            const targetDay = parseInt(value) || 1; // 1=周一, 7=周日
            const currentDayOfWeek = next.getUTCDay() === 0 ? 7 : next.getUTCDay();
            if (targetDay === currentDayOfWeek && targetTotalMinutes > currentTotalMinutes) {
                // 今天是目标星期几，且时间没到，返回今天
                const result = year + '-' + String(month + 1).padStart(2, '0') + '-' + String(day).padStart(2, '0');
                console.log('返回今天(weekly):', result);
                return result;
            }
            // 否则继续计算下一个目标星期几
        } else {
            // 其他类型：如果设置的时间还没到，返回今天
            if (targetTotalMinutes > currentTotalMinutes) {
                const result = year + '-' + String(month + 1).padStart(2, '0') + '-' + String(day).padStart(2, '0');
                console.log('返回今天:', result);
                return result;
            }
        }
    }
    
    // 计算下一个周期
    switch (type) {
        case 'daily':
            next.setUTCDate(next.getUTCDate() + 1);
            break;
            
        case 'weekly':
            {
                const targetDay = parseInt(value) || 1;
                const currentDay = next.getUTCDay() === 0 ? 7 : next.getUTCDay();
                let daysToAdd = (targetDay - currentDay + 7) % 7;
                if (daysToAdd === 0) daysToAdd = 7;
                next.setUTCDate(next.getUTCDate() + daysToAdd);
            }
            break;
            
        case 'monthly':
            {
                const targetDate = Math.min(parseInt(value) || day, 28);
                next.setUTCDate(targetDate);
                if (next.getUTCFullYear() < year || 
                    (next.getUTCFullYear() === year && next.getUTCMonth() < month) ||
                    (next.getUTCFullYear() === year && next.getUTCMonth() === month && next.getUTCDate() <= day)) {
                    next.setUTCMonth(next.getUTCMonth() + 1);
                }
            }
            break;
            
        case 'yearly':
            {
                const parts = (value || '1-1').split('-');
                const targetMonth = parseInt(parts[0]) || 1;
                const targetDay = Math.min(parseInt(parts[1]) || 1, 28);
                next.setUTCMonth(targetMonth - 1, targetDay);
                if (next.getUTCFullYear() <= year && next.getUTCMonth() <= month && next.getUTCDate() <= day) {
                    next.setUTCFullYear(next.getUTCFullYear() + 1);
                }
            }
            break;
            
        case 'specific':
            return currentDate;
    }
    
    // 返回本地日期字符串
    const resultYear = next.getUTCFullYear();
    const resultMonth = String(next.getUTCMonth() + 1).padStart(2, '0');
    const resultDay = String(next.getUTCDate()).padStart(2, '0');
    return resultYear + '-' + resultMonth + '-' + resultDay;
}
async function sendTelegramMessage(env, sub, nextDate) {
    const days = ['', '周一', '周二', '周三', '周四', '周五', '周六', '周日'];
    const cycleLabels = {
        daily: '每日',
        weekly: '每周' + days[parseInt(sub.cycle_value) || 1],
        monthly: '每月' + sub.cycle_value + '日',
        yearly: '每年' + sub.cycle_value,
        specific: sub.cycle_value
    };
    const tzLabels = { 'UTC': 'UTC', 'CST': '北京时间', 'ET': '美国东部' };
    
    // 使用传入的 nextDate 或 sub.next_notify_date
    const displayDate = nextDate || sub.next_notify_date;
    let nextNotifyText = '下次通知: ' + displayDate + ' ' + (sub.cycle_hour || '09') + ':' + (sub.cycle_minute || '00');
    if (sub.cycle_type === 'specific') {
        nextNotifyText = '下次通知: 一次性通知已完成，该通知已暂停';
    }
    
    const message = '订阅到期提醒\n\n' +
        '名称: ' + sub.name + '\n' +
        '内容: ' + sub.content + '\n' +
        '周期: ' + (cycleLabels[sub.cycle_type] || sub.cycle_type) + ' ' + (sub.cycle_hour || '09') + ':' + (sub.cycle_minute || '00') + '\n' +
        '时区: ' + (tzLabels[sub.timezone] || sub.timezone) + '\n' +
        nextNotifyText;
    
    await fetch('https://api.telegram.org/bot' + env.TELEGRAM_BOT_TOKEN + '/sendMessage', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ chat_id: env.TELEGRAM_CHAT_ID, text: message })
    });
}

// 处理Telegram Webhook
async function handleTelegram(request, env) {
    if (request.method !== 'POST') {
        return new Response('OK');
    }
    
    const update = await request.json();
    if (!update.message || !update.message.text) {
        return new Response('OK');
    }
    
    const chatId = update.message.chat.id;
    const text = update.message.text;
    
    const sendMessage = async (msg) => {
        await fetch('https://api.telegram.org/bot' + env.TELEGRAM_BOT_TOKEN + '/sendMessage', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ chat_id: chatId, text: msg })
        });
    };
    
    if (text === '/start' || text === '/help') {
        await sendMessage('订阅通知机器人\n\n可用命令:\n/start - 开始使用\n/help - 查看帮助\n/list - 查看订阅\n/today - 今日通知\n/status - 系统状态');
    } else if (text === '/list') {
        const { results } = await env.DB.prepare('SELECT * FROM subscriptions WHERE is_active=1').all();
        if (results.length === 0) {
            await sendMessage('暂无订阅');
        } else {
            let msg = '订阅列表:\n\n';
            results.forEach((s, i) => {
                msg += (i + 1) + '. ' + s.name + '\n   ' + s.next_notify_date + ' ' + (s.cycle_hour || '09') + ':' + (s.cycle_minute || '00') + ' (' + (s.timezone || 'UTC') + ')\n\n';
            });
            await sendMessage(msg);
        }
    } else if (text === '/today') {
        const now = new Date();
        const today = now.toISOString().split('T')[0];
        const hour = String(now.getUTCHours()).padStart(2, '0');
        const { results } = await env.DB.prepare(
            'SELECT * FROM subscriptions WHERE next_notify_date<=? AND cycle_hour<=? AND is_active=1'
        ).bind(today, hour).all();
        
        if (results.length === 0) {
            await sendMessage('今日无待通知');
        } else {
            let msg = '今日待通知:\n\n';
            results.forEach((s, i) => {
                msg += (i + 1) + '. ' + s.name + ' ' + (s.cycle_hour || '09') + ':' + (s.cycle_minute || '00') + ' (' + (s.timezone || 'UTC') + ')\n';
            });
            await sendMessage(msg);
        }
    } else if (text === '/status') {
        const { results: subs } = await env.DB.prepare('SELECT COUNT(*) as count FROM subscriptions WHERE is_active=1').all();
        const now = new Date();
        await sendMessage(
            '系统状态\n\n' +
            '世界时钟: ' + formatDateTime(now, 0) + '\n' +
            '北京时间: ' + formatDateTime(now, 8) + '\n' +
            '美国东部: ' + formatDateTime(now, -4) + '\n' +
            '活跃订阅: ' + subs[0].count + ' 个'
        );
    }
    
    return new Response('OK');
}

// HTML页面
function getHTML() {
    return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>订阅通知面板</title>
<style>
*{margin:0;padding:0;box-sizing:border-box}
body{font-family:system-ui,-apple-system,sans-serif;background:#f1f5f9;color:#1e293b}
.loading{min-height:100vh;display:flex;align-items:center;justify-content:center;background:linear-gradient(135deg,#667eea,#764ba2);flex-direction:column;color:#fff}
.spinner{width:48px;height:48px;border:4px solid rgba(255,255,255,.3);border-top-color:#fff;border-radius:50%;animation:spin 1s linear infinite;margin-bottom:20px}
@keyframes spin{to{transform:rotate(360deg)}}
.login{min-height:100vh;display:flex;align-items:center;justify-content:center;background:linear-gradient(135deg,#667eea,#764ba2);padding:20px}
.login-box{background:#fff;border-radius:16px;padding:40px;width:100%;max-width:400px;text-align:center;box-shadow:0 20px 60px rgba(0,0,0,.3)}
.login-box h1{font-size:24px;margin-bottom:8px}
.login-box p{color:#64748b;margin-bottom:24px;font-size:14px}
.form-group{margin-bottom:20px;text-align:left}
.form-group label{display:block;margin-bottom:8px;font-weight:500;font-size:14px}
.form-group input,.form-group select{width:100%;padding:12px;border:2px solid #e2e8f0;border-radius:8px;font-size:14px;outline:none}
.form-group input:focus,.form-group select:focus{border-color:#6366f1}
.btn{padding:12px 24px;border:none;border-radius:8px;font-size:14px;font-weight:500;cursor:pointer}
.btn-primary{background:#6366f1;color:#fff;width:100%}
.btn-primary:hover{background:#4f46e5}
.btn-primary:disabled{opacity:.6}
.error{color:#ef4444;font-size:14px;margin-top:12px}
.navbar{background:linear-gradient(135deg,#667eea,#764ba2);color:#fff;padding:0 20px;height:60px;display:flex;align-items:center;justify-content:space-between;position:sticky;top:0;z-index:100}
.navbar h1{font-size:18px;font-weight:600}
.navbar .btn{background:rgba(255,255,255,.2);color:#fff;padding:8px 16px;font-size:13px;border:1px solid rgba(255,255,255,.3)}
.main{padding:20px;max-width:1200px;margin:0 auto}
.time-cards{display:grid;grid-template-columns:repeat(3,1fr);gap:12px;margin-bottom:20px}
.time-card{border-radius:12px;padding:16px;color:#fff}
.time-card.utc{background:linear-gradient(135deg,#3b82f6,#2563eb)}
.time-card.cst{background:linear-gradient(135deg,#ef4444,#dc2626)}
.time-card.et{background:linear-gradient(135deg,#8b5cf6,#7c3aed)}
.time-card .label{font-size:12px;opacity:.8;margin-bottom:4px}
.time-card .time{font-size:18px;font-weight:600}
.action-cards{display:grid;grid-template-columns:repeat(3,1fr);gap:12px;margin-bottom:20px}
.action-card{background:#fff;border-radius:12px;padding:16px;box-shadow:0 1px 3px rgba(0,0,0,.1);cursor:pointer;transition:all 0.2s;text-align:center;border:2px solid transparent}
.action-card:hover{transform:translateY(-2px);box-shadow:0 4px 12px rgba(0,0,0,.15)}
.action-card.add{border-color:#22c55e}
.action-card.notify{border-color:#3b82f6}
.action-card.test{border-color:#8b5cf6}
.action-card .icon{font-size:32px;margin-bottom:8px}
.action-card .label{font-size:14px;font-weight:500}
.stats{display:grid;grid-template-columns:repeat(3,1fr);gap:16px;margin-bottom:20px}
.stat{background:#fff;border-radius:12px;padding:20px;display:flex;align-items:center;gap:16px;box-shadow:0 1px 3px rgba(0,0,0,.1)}
.stat-icon{width:48px;height:48px;border-radius:12px;display:flex;align-items:center;justify-content:center;font-size:20px;font-weight:bold}
.stat-icon.blue{background:#dbeafe;color:#2563eb}
.stat-icon.green{background:#dcfce7;color:#16a34a}
.stat-icon.orange{background:#ffedd5;color:#ea580c}
.stat h3{font-size:24px;font-weight:700}
.stat p{font-size:14px;color:#64748b}
.card{background:#fff;border-radius:12px;box-shadow:0 1px 3px rgba(0,0,0,.1);overflow:hidden}
.card-header{padding:16px 20px;border-bottom:1px solid #e2e8f0;display:flex;justify-content:space-between;align-items:center}
.card-header h2{font-size:16px;font-weight:600}
table{width:100%;border-collapse:collapse}
th,td{padding:14px 20px;text-align:left;border-bottom:1px solid #e2e8f0;font-size:14px}
th{background:#f8fafc;font-size:12px;font-weight:600;text-transform:uppercase;color:#64748b}
tr:hover{background:#f8fafc}
.badge{display:inline-block;padding:4px 10px;border-radius:20px;font-size:12px;font-weight:500}
.badge-purple{background:#f3e8ff;color:#7c3aed}
.badge-green{background:#dcfce7;color:#16a34a}
.badge-red{background:#fee2e2;color:#dc2626}
.badge-blue{background:#dbeafe;color:#2563eb}
.actions{display:flex;gap:6px}
.actions button{padding:6px 10px;border:none;border-radius:6px;cursor:pointer;font-size:12px}
.actions .edit{background:#dbeafe;color:#2563eb}
.actions .pause{background:#fef3c7;color:#d97706}
.actions .resume{background:#dcfce7;color:#16a34a}
.actions .del{background:#fee2e2;color:#dc2626}
.empty{text-align:center;padding:60px 20px;color:#64748b}
.modal{position:fixed;top:0;left:0;right:0;bottom:0;background:rgba(0,0,0,.5);display:flex;align-items:center;justify-content:center;z-index:1000;padding:20px}
.modal-box{background:#fff;border-radius:16px;width:100%;max-width:500px;max-height:90vh;overflow-y:auto}
.modal-header{padding:20px;border-bottom:1px solid #e2e8f0;display:flex;justify-content:space-between;align-items:center}
.modal-header h3{font-size:18px;font-weight:600}
.modal-close{width:32px;height:32px;border:none;background:#f1f5f9;border-radius:8px;cursor:pointer;font-size:18px}
.modal-body{padding:20px}
.modal-footer{padding:16px 20px;border-top:1px solid #e2e8f0;display:flex;justify-content:flex-end;gap:12px}
.btn-cancel{background:#f1f5f9;color:#1e293b}
.toast{position:fixed;bottom:20px;right:20px;left:20px;max-width:400px;margin:0 auto;padding:16px 20px;border-radius:12px;color:#fff;font-weight:500;z-index:2000;box-shadow:0 10px 40px rgba(0,0,0,.2)}
.toast.ok{background:linear-gradient(135deg,#22c55e,#16a34a)}
.toast.err{background:linear-gradient(135deg,#ef4444,#dc2626)}
.form-row{display:grid;grid-template-columns:1fr 1fr;gap:12px}
@media(max-width:768px){.navbar{padding:0 12px}.main{padding:12px}.time-cards,.action-cards,.stats{grid-template-columns:1fr}th,td{padding:10px 12px;font-size:13px}.form-row{grid-template-columns:1fr}}
</style>
</head>
<body>
<div id="app">
    <div v-if="checking" class="loading">
        <div class="spinner"></div>
        <p>加载中...</p>
    </div>
    
    <div v-else-if="needLogin && !logged" class="login">
        <div class="login-box">
            <h1>订阅通知面板</h1>
            <p>请输入管理员密码登录</p>
            <form @submit.prevent="doLogin">
                <div class="form-group">
                    <label>密码</label>
                    <input v-model="pwd" type="password" required autofocus>
                </div>
                <button class="btn btn-primary" :disabled="logining">
                    {{ logining ? '登录中...' : '登录' }}
                </button>
                <p v-if="loginErr" class="error">{{ loginErr }}</p>
            </form>
        </div>
    </div>
    
    <div v-else>
        <nav class="navbar">
            <h1>订阅通知面板</h1>
            <div>
                <button v-if="needLogin" class="btn" @click="doLogout">退出</button>
            </div>
        </nav>
        
        <main class="main">
            <div class="time-cards">
                <div class="time-card utc">
                    <div class="label">世界协调时 UTC</div>
                    <div class="time">{{ times.utc }}</div>
                </div>
                <div class="time-card cst">
                    <div class="label">北京时间 CST</div>
                    <div class="time">{{ times.cst }}</div>
                </div>
                <div class="time-card et">
                    <div class="label">美国东部 ET</div>
                    <div class="time">{{ times.et }}</div>
                </div>
            </div>
            
            <div class="action-cards">
                <div class="action-card add" @click="openAdd">
                    <div class="icon">+</div>
                    <div class="label">添加订阅</div>
                </div>
                <div class="action-card notify" @click="doNotify">
                    <div class="icon">&uarr;</div>
                    <div class="label">立即通知</div>
                </div>
                <div class="action-card test" @click="testBot">
                    <div class="icon">T</div>
                    <div class="label">测试通知</div>
                </div>
            </div>
            
            <div class="stats">
                <div class="stat">
                    <div class="stat-icon blue">All</div>
                    <div>
                        <h3>{{ subs.length }}</h3>
                        <p>总订阅</p>
                    </div>
                </div>
                <div class="stat">
                    <div class="stat-icon green">On</div>
                    <div>
                        <h3>{{ active }}</h3>
                        <p>活跃</p>
                    </div>
                </div>
                <div class="stat">
                    <div class="stat-icon orange">!</div>
                    <div>
                        <h3>{{ due }}</h3>
                        <p>待通知</p>
                    </div>
                </div>
            </div>
            
            <div class="card">
                <div class="card-header">
                    <h2>订阅列表</h2>
                    <span style="color:#64748b;font-size:14px">共 {{ subs.length }} 个</span>
                </div>
                
                <div v-if="loading" style="padding:40px;text-align:center">
                    <p>加载中...</p>
                </div>
                
                <div v-else-if="subs.length === 0" class="empty">
                    <p>暂无订阅</p>
                </div>
                
                <table v-else>
                    <thead>
                        <tr>
                            <th>#</th>
                            <th>名称</th>
                            <th>周期</th>
                            <th>时区</th>
                            <th>下次通知</th>
                            <th>状态</th>
                            <th>操作</th>
                        </tr>
                    </thead>
                    <tbody>
                        <tr v-for="(s, index) in subs" :key="s.id">
                            <td>{{ index + 1 }}</td>
                            <td><strong>{{ s.name }}</strong></td>
                            <td><span class="badge badge-purple">{{ cycleLabel(s) }}</span></td>
                            <td><span class="badge badge-blue">{{ tzLabel(s.timezone) }}</span></td>
                            <td>{{ s.cycle_type === 'specific' && !s.is_active ? '已完成' : s.next_notify_date + ' ' + (s.cycle_hour || '09') + ':' + (s.cycle_minute || '00') }}</td>
                            <td>
                                <span :class="s.is_active ? 'badge badge-green' : 'badge badge-red'">
                                    {{ s.is_active ? '活跃' : '暂停' }}
                                </span>
                            </td>
                            <td class="actions">
                                <button class="edit" @click="openEdit(s)">编辑</button>
                                <button v-if="s.is_active" class="pause" @click="toggle(s)">暂停</button>
                                <button v-else class="resume" @click="toggle(s)">恢复</button>
                                <button class="del" @click="del(s.id)">删除</button>
                            </td>
                        </tr>
                    </tbody>
                </table>
            </div>
        </main>
    </div>
    
    <div v-if="modal" class="modal" @click.self="modal = false">
        <div class="modal-box">
            <div class="modal-header">
                <h3>{{ editId ? '编辑' : '添加' }}订阅</h3>
                <button class="modal-close" @click="modal = false">X</button>
            </div>
            <form @submit.prevent="save">
                <div class="modal-body">
                    <div class="form-group">
                        <label>名称 *</label>
                        <input v-model="form.name" required placeholder="订阅名称">
                    </div>
                    <div class="form-group">
                        <label>内容 *</label>
                        <input v-model="form.content" required placeholder="描述说明">
                    </div>
                    <div class="form-row">
                        <div class="form-group">
                            <label>周期类型 *</label>
                            <select v-model="form.cycle_type" required>
                                <option value="">请选择</option>
                                <option value="daily">每日</option>
                                <option value="weekly">每周</option>
                                <option value="monthly">每月</option>
                                <option value="yearly">每年</option>
                                <option value="specific">指定日期</option>
                            </select>
                        </div>
                        <div class="form-group">
                            <label>时区 *</label>
                            <select v-model="form.timezone" required>
                                <option value="UTC">世界协调时 UTC</option>
                                <option value="CST">北京时间 CST</option>
                                <option value="ET">美国东部 ET</option>
                            </select>
                        </div>
                    </div>
                    <div class="form-row">
                        <div v-if="form.cycle_type === 'weekly'" class="form-group">
                            <label>星期 *</label>
                            <select v-model="form.cycle_value" required>
                                <option value="">请选择</option>
                                <option value="1">周一</option>
                                <option value="2">周二</option>
                                <option value="3">周三</option>
                                <option value="4">周四</option>
                                <option value="5">周五</option>
                                <option value="6">周六</option>
                                <option value="7">周日</option>
                            </select>
                        </div>
                        <div v-if="form.cycle_type === 'monthly'" class="form-group">
                            <label>日期 * (1-28)</label>
                            <input v-model="form.cycle_value" type="number" min="1" max="28" required>
                        </div>
                        <div v-if="form.cycle_type === 'yearly'" class="form-group">
                            <label>月-日 *</label>
                            <input v-model="form.cycle_value" required placeholder="MM-DD">
                        </div>
                        <div v-if="form.cycle_type === 'specific'" class="form-group">
                            <label>日期 *</label>
                            <input v-model="form.cycle_value" type="date" required>
                        </div>
                        <div class="form-group">
                            <label>时间 *</label>
                            <div style="display:flex;gap:8px">
                                <select v-model="form.cycle_hour" required style="flex:1">
                                    <option v-for="h in 24" :key="h-1" :value="String(h-1).padStart(2,'0')">
                                        {{ String(h-1).padStart(2,'0') }}时
                                    </option>
                                </select>
                                <select v-model="form.cycle_minute" required style="flex:1">
                                    <option v-for="m in 6" :key="(m-1)*10" :value="String((m-1)*10).padStart(2,'0')">
                                        {{ String((m-1)*10).padStart(2,'0') }}分
                                    </option>
                                </select>
                            </div>
                        </div>
                    </div>
                </div>
                <div class="modal-footer">
                    <button type="button" class="btn btn-cancel" @click="modal = false">取消</button>
                    <button type="submit" class="btn btn-primary" style="width:auto">保存</button>
                </div>
            </form>
        </div>
    </div>
    
    <div v-if="toast.show" :class="'toast ' + toast.type">{{ toast.msg }}</div>
</div>

<script src="https://cdn.jsdelivr.net/npm/vue@3/dist/vue.global.prod.js"></script>
<script>
const { createApp, ref, computed, onMounted, onUnmounted } = Vue;

createApp({
    setup() {
        const checking = ref(true);
        const needLogin = ref(false);
        const logged = ref(false);
        const pwd = ref('');
        const logining = ref(false);
        const loginErr = ref('');
        const subs = ref([]);
        const loading = ref(false);
        const modal = ref(false);
        const editId = ref(null);
        const form = ref({
            name: '',
            content: '',
            cycle_type: '',
            cycle_value: '',
            cycle_hour: '09',
            cycle_minute: '00',
            timezone: 'UTC'
        });
        const toast = ref({ show: false, msg: '', type: 'ok' });
        const times = ref({ utc: '', cst: '', et: '' });
        let timer = null;
        
        const active = computed(() => subs.value.filter(s => s.is_active).length);
        const due = computed(() => {
            const today = new Date().toISOString().split('T')[0];
            const hour = String(new Date().getUTCHours()).padStart(2, '0');
            return subs.value.filter(s => s.is_active && s.next_notify_date <= today && s.cycle_hour <= hour).length;
        });
        
        const show = (msg, type) => {
            toast.value = { show: true, msg: msg, type: type || 'ok' };
            setTimeout(() => { toast.value.show = false; }, 3000);
        };
        
        const updateClock = async () => {
            try {
                const r = await fetch('/api/server-time');
                if (r.ok) times.value = await r.json();
            } catch (e) {}
        };
        
        const api = async (url, opt) => {
            opt = opt || {};
            const token = localStorage.getItem('token');
            const headers = { 'Content-Type': 'application/json' };
            if (token) headers['Authorization'] = 'Bearer ' + token;
            const r = await fetch(url, { method: opt.method || 'GET', headers: headers, body: opt.body });
            if (r.status === 401) {
                logged.value = false;
                throw new Error('401');
            }
            return r;
        };
        
        const check = async () => {
            try {
                const r = await fetch('/api/auth/status');
                if (r.ok) {
                    const d = await r.json();
                    needLogin.value = d.requireAuth;
                    if (needLogin.value) {
                        const t = localStorage.getItem('token');
                        if (t) {
                            const v = await (await fetch('/api/auth/verify', {
                                method: 'POST',
                                headers: { 'Content-Type': 'application/json' },
                                body: JSON.stringify({ token: t })
                            })).json();
                            logged.value = v.valid;
                            if (!v.valid) localStorage.removeItem('token');
                        } else {
                            logged.value = false;
                        }
                    } else {
                        logged.value = true;
                    }
                }
                if (logged.value) fetchSubs();
            } catch (e) {
                logged.value = true;
                fetchSubs();
            } finally {
                checking.value = false;
                updateClock();
                timer = setInterval(updateClock, 1000);
            }
        };
        
        onUnmounted(() => {
            if (timer) clearInterval(timer);
        });
        
        const doLogin = async () => {
            logining.value = true;
            loginErr.value = '';
            try {
                const r = await fetch('/api/login', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ password: pwd.value })
                });
                const d = await r.json();
                if (d.success) {
                    localStorage.setItem('token', d.token);
                    logged.value = true;
                    show('登录成功');
                    fetchSubs();
                } else {
                    loginErr.value = d.error || '密码错误';
                }
            } catch (e) {
                loginErr.value = '登录失败';
            } finally {
                logining.value = false;
            }
        };
        
        const doLogout = () => {
            localStorage.removeItem('token');
            logged.value = false;
            subs.value = [];
        };
        
        const fetchSubs = async () => {
            try {
                loading.value = true;
                const r = await api('/api/subscriptions');
                if (r.ok) subs.value = await r.json();
            } catch (e) {
                if (e.message !== '401') show('加载失败', 'err');
            } finally {
                loading.value = false;
            }
        };
        
        const openAdd = () => {
            editId.value = null;
            form.value = { name: '', content: '', cycle_type: '', cycle_value: '', cycle_hour: '09', cycle_minute: '00', timezone: 'UTC' };
            modal.value = true;
        };
        
        const openEdit = (s) => {
            editId.value = s.id;
            form.value = {
                name: s.name,
                content: s.content,
                cycle_type: s.cycle_type,
                cycle_value: s.cycle_value,
                cycle_hour: s.cycle_hour || '09',
                cycle_minute: s.cycle_minute || '00',
                timezone: s.timezone || 'UTC'
            };
            modal.value = true;
        };
        
        const save = async () => {
            try {
                const url = editId.value ? '/api/subscriptions/' + editId.value : '/api/subscriptions';
                const r = await api(url, {
                    method: editId.value ? 'PUT' : 'POST',
                    body: JSON.stringify(form.value)
                });
                if (r.ok) {
                    show(editId.value ? '更新成功' : '添加成功');
                    modal.value = false;
                    fetchSubs();
                } else {
                    const d = await r.json();
                    show(d.error || '操作失败', 'err');
                }
            } catch (e) {
                if (e.message !== '401') show('操作失败', 'err');
            }
        };
        
        const del = async (id) => {
            if (!confirm('确定删除此订阅？')) return;
            try {
                const r = await api('/api/subscriptions/' + id, { method: 'DELETE' });
                if (r.ok) {
                    show('删除成功');
                    fetchSubs();
                }
            } catch (e) {
                if (e.message !== '401') show('删除失败', 'err');
            }
        };
        
        const toggle = async (s) => {
            try {
                const r = await api('/api/subscriptions/' + s.id, {
                    method: 'PUT',
                    body: JSON.stringify({ is_active: !s.is_active })
                });
                if (r.ok) {
                    show(s.is_active ? '已暂停' : '已恢复');
                    fetchSubs();
                }
            } catch (e) {
                if (e.message !== '401') show('操作失败', 'err');
            }
        };
        
        const doNotify = async () => {
            try {
                const r = await api('/api/notify', { method: 'POST' });
                if (r.ok) {
                    const d = await r.json();
                    show('已发送 ' + d.sent + ' 条通知');
                    fetchSubs();
                }
            } catch (e) {
                if (e.message !== '401') show('通知失败', 'err');
            }
        };
        
        const testBot = async () => {
            try {
                const r = await api('/api/test-telegram', { method: 'POST' });
                const d = await r.json();
                if (d.success) {
                    show('测试通知已发送，请检查Telegram', 'ok');
                } else {
                    show('测试失败: ' + (d.error || d.message || '未知错误'), 'err');
                }
            } catch (e) {
                show('测试失败: 网络错误', 'err');
            }
        };
        
        const cycleLabel = (s) => {
            const days = ['', '周一', '周二', '周三', '周四', '周五', '周六', '周日'];
            let label = '';
            switch (s.cycle_type) {
                case 'daily':
                    label = '每日';
                    break;
                case 'weekly':
                    label = '每周' + days[parseInt(s.cycle_value) || 1];
                    break;
                case 'monthly':
                    label = '每月' + parseInt(s.cycle_value || 1) + '日';
                    break;
                case 'yearly':
                    const parts = (s.cycle_value || '1-1').split('-');
                    label = '每年' + parseInt(parts[0]) + '月' + parseInt(parts[1]) + '日';
                    break;
                case 'specific':
                    label = s.cycle_value;
                    break;
                default:
                    label = s.cycle_type;
            }
            return label;
        };
        
        const tzLabel = (tz) => {
            const labels = { 'UTC': '世界时间/UTC', 'CST': '北京时间/CST', 'ET': '美国时间/ET' };
            return labels[tz] || tz;
        };
        
        onMounted(check);
        
        return {
            checking, needLogin, logged, pwd, logining, loginErr,
            subs, loading, modal, editId, form, times, toast,
            active, due,
            doLogin, doLogout, openAdd, openEdit, save, del, toggle,
            doNotify, testBot, cycleLabel, tzLabel
        };
    }
}).mount('#app');
</script>
</body>
</html>`;
}