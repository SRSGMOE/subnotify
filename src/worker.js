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
            if (env.TELEGRAM_BOT_TOKEN && !env.BOT_COMMANDS_SET) {
                await setBotCommands(env);
            }
            
            if (path === '/api/health') {
                return new Response(JSON.stringify({ status: 'ok' }), { headers: { 'Content-Type': 'application/json' } });
            }
            
            if (path === '/' || path === '/index.html') {
                return new Response(getHTML(), { headers: { 'Content-Type': 'text/html;charset=utf-8' } });
            }
            
            if (path.startsWith('/api/')) {
                const apiPath = path.replace('/api', '') || '/';
                const response = await handleAPI(request, env, apiPath);
                const newResponse = new Response(response.body, response);
                Object.entries(corsHeaders).forEach(([k, v]) => newResponse.headers.set(k, v));
                if (!newResponse.headers.get('Content-Type')) newResponse.headers.set('Content-Type', 'application/json');
                return newResponse;
            }
            
            if (path === '/webhook/telegram') return handleTelegram(request, env);
            
            return new Response('Not Found', { status: 404 });
        } catch (error) {
            return new Response(JSON.stringify({ error: error.message }), {
                status: 500,
                headers: { ...corsHeaders, 'Content-Type': 'application/json' }
            });
        }
    }
};

async function setBotCommands(env) {
    try {
        await fetch(`https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/setMyCommands`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                commands: [
                    { command: 'start', description: '开始使用' },
                    { command: 'help', description: '查看帮助' },
                    { command: 'list', description: '查看所有订阅' },
                    { command: 'today', description: '今日待通知' },
                    { command: 'status', description: '系统状态' }
                ]
            })
        });
    } catch (e) { console.error('设置Bot命令失败:', e); }
}

function getTimezoneOffset(tz) {
    const offsets = { 'UTC': 0, 'CST': 8, 'ET': -4 };
    return offsets[tz] || 0;
}

function formatTime(date, tz) {
    const offset = getTimezoneOffset(tz);
    const local = new Date(date.getTime() + offset * 3600000);
    return local.toISOString().replace('T', ' ').substring(0, 19);
}

function getTimezoneLabel(tz) {
    const labels = { 'UTC': '世界协调时 UTC', 'CST': '北京时间 CST', 'ET': '美国东部 ET' };
    return labels[tz] || tz;
}

async function handleAPI(request, env, path) {
    const method = request.method;
    const json = (data, status = 200) => new Response(JSON.stringify(data), { status });
    
    if (!env.DB) return json({ error: '请在 Worker Settings 绑定 D1 数据库' }, 500);
    
    await initDB(env.DB);
    
    if (path === '/auth/status') return json({ requireAuth: !!env.ADMIN_PASSWORD });
    
    if (path === '/login' && method === 'POST') {
        const { password } = await request.json();
        if (!env.ADMIN_PASSWORD) return json({ success: true, token: 'no-auth' });
        if (password === env.ADMIN_PASSWORD) return json({ success: true, token: genToken(env.ADMIN_PASSWORD) });
        return json({ success: false, error: '密码错误' }, 401);
    }
    
    if (path === '/auth/verify' && method === 'POST') {
        const { token } = await request.json();
        if (!env.ADMIN_PASSWORD) return json({ valid: true });
        return json({ valid: token === genToken(env.ADMIN_PASSWORD) });
    }
    
    if (path === '/server-time') {
        const now = new Date();
        return json({
            utc: formatTime(now, 'UTC'),
            cst: formatTime(now, 'CST'),
            et: formatTime(now, 'ET')
        });
    }
    
    if (env.ADMIN_PASSWORD) {
        const auth = request.headers.get('Authorization')?.replace('Bearer ', '');
        if (auth !== genToken(env.ADMIN_PASSWORD)) return json({ error: '未授权' }, 401);
    }
    
    if (path === '/status') {
        return json({
            db: !!env.DB,
            telegram: !!env.TELEGRAM_BOT_TOKEN && !!env.TELEGRAM_CHAT_ID
        });
    }
    
    if (path === '/test-telegram' && method === 'POST') {
        try {
            const res = await fetch(`https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/sendMessage`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    chat_id: env.TELEGRAM_CHAT_ID,
                    text: '恭喜，Bot已经连接成功啦！\n\n发送 /help 或者 /start 查看可用命令'
                })
            });
            const data = await res.json();
            return json({ success: data.ok, message: data.description, sentText: '恭喜，Bot已经连接成功啦！' });
        } catch (error) {
            return json({ success: false, error: error.message });
        }
    }
    
    if (path === '/subscriptions' && method === 'GET') {
        const { results } = await env.DB.prepare('SELECT * FROM subscriptions ORDER BY next_notify_date').all();
        return json(results);
    }
    
    if (path === '/subscriptions' && method === 'POST') {
        const body = await request.json();
        if (!body.name || !body.content || !body.cycle_type || !body.timezone) return json({ error: '所有字段必填' }, 400);
        const nextDate = calcNextDate(body.cycle_type, body.cycle_value, body.cycle_hour, body.timezone);
        await env.DB.prepare('INSERT INTO subscriptions (name,content,cycle_type,cycle_value,cycle_hour,timezone,next_notify_date) VALUES (?,?,?,?,?,?,?)')
            .bind(body.name, body.content, body.cycle_type, body.cycle_value || '', body.cycle_hour || '09', body.timezone || 'UTC', nextDate).run();
        return json({ success: true }, 201);
    }
    
    const match = path.match(/^\/subscriptions\/(\d+)$/);
    if (match) {
        const id = match[1];
        if (method === 'GET') {
            const { results } = await env.DB.prepare('SELECT * FROM subscriptions WHERE id=?').bind(id).all();
            return results.length ? json(results[0]) : json({ error: '不存在' }, 404);
        }
        if (method === 'PUT') {
            const body = await request.json();
            let sql = "UPDATE subscriptions SET updated_at=datetime('now')";
            const p = [];
            if (body.name !== undefined) { sql += ',name=?'; p.push(body.name); }
            if (body.content !== undefined) { sql += ',content=?'; p.push(body.content); }
            if (body.cycle_type !== undefined) { sql += ',cycle_type=?'; p.push(body.cycle_type); }
            if (body.cycle_value !== undefined) { sql += ',cycle_value=?'; p.push(body.cycle_value); }
            if (body.cycle_hour !== undefined) { sql += ',cycle_hour=?'; p.push(body.cycle_hour); }
            if (body.timezone !== undefined) { sql += ',timezone=?'; p.push(body.timezone); }
            if (body.is_active !== undefined) { sql += ',is_active=?'; p.push(body.is_active ? 1 : 0); }
            if (body.cycle_type) { sql += ',next_notify_date=?'; p.push(calcNextDate(body.cycle_type, body.cycle_value, body.cycle_hour, body.timezone)); }
            sql += ' WHERE id=?'; p.push(id);
            await env.DB.prepare(sql).bind(...p).run();
            return json({ success: true });
        }
        if (method === 'DELETE') {
            await env.DB.prepare('DELETE FROM subscriptions WHERE id=?').bind(id).run();
            return json({ success: true });
        }
    }
    
    if (path === '/notify' && method === 'POST') {
        const now = new Date();
        const currentDate = now.toISOString().split('T')[0];
        const currentHour = String(now.getUTCHours()).padStart(2, '0');
        const { results } = await env.DB.prepare(
            'SELECT * FROM subscriptions WHERE next_notify_date<=? AND cycle_hour<=? AND is_active=1'
        ).bind(currentDate, currentHour).all();
        let sent = 0;
        for (const sub of results) {
            try {
                if (env.TELEGRAM_BOT_TOKEN && env.TELEGRAM_CHAT_ID) await sendTelegram(env, sub);
                await env.DB.prepare('UPDATE subscriptions SET next_notify_date=? WHERE id=?').bind(calcNextDate(sub.cycle_type, sub.cycle_value, sub.cycle_hour, sub.timezone), sub.id).run();
                sent++;
            } catch (e) { console.error(e); }
        }
        return json({ checked: results.length, sent });
    }
    
    return json({ error: '未找到路由' }, 404);
}

async function initDB(db) {
    try {
        const { results } = await db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='subscriptions'").all();
        if (results.length === 0) {
            await db.exec("CREATE TABLE IF NOT EXISTS subscriptions (id INTEGER PRIMARY KEY AUTOINCREMENT,name TEXT NOT NULL,content TEXT NOT NULL,cycle_type TEXT NOT NULL,cycle_value TEXT,cycle_hour TEXT DEFAULT '09',timezone TEXT DEFAULT 'UTC',next_notify_date TEXT NOT NULL,created_at TEXT DEFAULT (datetime('now')),updated_at TEXT DEFAULT (datetime('now')),is_active INTEGER DEFAULT 1);CREATE TABLE IF NOT EXISTS notifications (id INTEGER PRIMARY KEY AUTOINCREMENT,subscription_id INTEGER NOT NULL,sent_at TEXT DEFAULT (datetime('now')),status TEXT DEFAULT 'success');");
        } else {
            const { results: columns } = await db.prepare("PRAGMA table_info(subscriptions)").all();
            if (!columns.some(c => c.name === 'cycle_hour')) await db.exec("ALTER TABLE subscriptions ADD COLUMN cycle_hour TEXT DEFAULT '09'");
            if (!columns.some(c => c.name === 'timezone')) await db.exec("ALTER TABLE subscriptions ADD COLUMN timezone TEXT DEFAULT 'UTC'");
        }
    } catch (e) { console.error('DB init error:', e); }
}

function genToken(pwd) { let h = 0; for (let i = 0; i < pwd.length; i++) h = ((h << 5) - h) + pwd.charCodeAt(i); return 'auth_' + Math.abs(h).toString(36); }

function calcNextDate(type, value, hour, timezone) {
    hour = hour || '09';
    timezone = timezone || 'UTC';
    const offset = getTimezoneOffset(timezone);
    const now = new Date();
    const localNow = new Date(now.getTime() + offset * 3600000);
    const next = new Date(now.getTime());
    next.setUTCHours(parseInt(hour) - offset, 0, 0, 0);
    
    switch (type) {
        case 'daily':
            next.setUTCDate(now.getUTCDate() + 1);
            if (next <= now) next.setUTCDate(next.getUTCDate() + 1);
            break;
        case 'weekly':
            const d = parseInt(value) || 1;
            const c = localNow.getUTCDay() || 7;
            let daysUntil = (d - c + 7) % 7;
            if (daysUntil === 0 && next <= now) daysUntil = 7;
            next.setUTCDate(now.getUTCDate() + daysUntil);
            break;
        case 'monthly':
            const day = Math.min(parseInt(value) || 1, 28);
            next.setUTCDate(day);
            if (next <= now) next.setUTCMonth(next.getUTCMonth() + 1);
            break;
        case 'yearly':
            const [m, dy] = (value || '1-1').split('-').map(Number);
            next.setUTCMonth(m - 1, Math.min(dy, 28));
            if (next <= now) next.setUTCFullYear(next.getUTCFullYear() + 1);
            break;
        case 'specific':
            return value;
    }
    return next.toISOString().split('T')[0];
}

async function sendTelegram(env, sub) {
    const days = ['', '一', '二', '三', '四', '五', '六', '日'];
    const cycleLabels = { daily: '每日', weekly: '每周' + days[parseInt(sub.cycle_value) || 1], monthly: '每月' + sub.cycle_value + '日', yearly: '每年' + sub.cycle_value, specific: sub.cycle_value };
    const tzLabel = getTimezoneLabel(sub.timezone || 'UTC');
    const msg = '订阅到期提醒\n\n' +
        '名称: ' + sub.name + '\n' +
        '内容: ' + sub.content + '\n' +
        '周期: ' + (cycleLabels[sub.cycle_type] || sub.cycle_type) + ' ' + (sub.cycle_hour || '09') + ':00\n' +
        '时区: ' + tzLabel + '\n' +
        '下次通知: ' + sub.next_notify_date;
    await fetch('https://api.telegram.org/bot' + env.TELEGRAM_BOT_TOKEN + '/sendMessage', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ chat_id: env.TELEGRAM_CHAT_ID, text: msg })
    });
}

async function handleTelegram(request, env) {
    if (request.method !== 'POST') return new Response('OK');
    const update = await request.json();
    if (!update.message || !update.message.text) return new Response('OK');
    const chatId = update.message.chat.id;
    const text = update.message.text;
    const send = async (msg) => {
        await fetch('https://api.telegram.org/bot' + env.TELEGRAM_BOT_TOKEN + '/sendMessage', {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ chat_id: chatId, text: msg })
        });
    };
    if (text === '/start' || text === '/help') {
        await send('订阅通知机器人\n\n可用命令:\n/start - 开始使用\n/help - 查看帮助\n/list - 查看所有订阅\n/today - 今日待通知\n/status - 系统状态');
    } else if (text === '/list') {
        const { results } = await env.DB.prepare('SELECT * FROM subscriptions WHERE is_active=1').all();
        if (results.length === 0) await send('暂无订阅');
        else {
            let msg = '订阅列表:\n\n';
            results.forEach((s, i) => { msg += (i + 1) + '. ' + s.name + '\n   内容: ' + s.content + '\n   时区: ' + getTimezoneLabel(s.timezone) + '\n   时间: ' + s.next_notify_date + ' ' + (s.cycle_hour || '09') + ':00\n\n'; });
            await send(msg);
        }
    } else if (text === '/today') {
        const now = new Date();
        const today = now.toISOString().split('T')[0];
        const currentHour = String(now.getUTCHours()).padStart(2, '0');
        const { results } = await env.DB.prepare('SELECT * FROM subscriptions WHERE next_notify_date<=? AND cycle_hour<=? AND is_active=1').bind(today, currentHour).all();
        if (results.length === 0) await send('今日无待通知');
        else {
            let msg = '今日待通知:\n\n';
            results.forEach((s, i) => { msg += (i + 1) + '. ' + s.name + ' - ' + (s.cycle_hour || '09') + ':00 (' + (s.timezone || 'UTC') + ')\n'; });
            await send(msg);
        }
    } else if (text === '/status') {
        const { results: subs } = await env.DB.prepare('SELECT COUNT(*) as count FROM subscriptions WHERE is_active=1').all();
        const now = new Date();
        await send('系统状态\n\nUTC: ' + formatTime(now, 'UTC') + '\n北京: ' + formatTime(now, 'CST') + '\n东部: ' + formatTime(now, 'ET') + '\n活跃订阅: ' + subs[0].count + ' 个');
    }
    return new Response('OK');
}

function getHTML() {
    return '<!DOCTYPE html>\n<html lang="zh-CN">\n<head>\n<meta charset="UTF-8">\n<meta name="viewport" content="width=device-width, initial-scale=1.0">\n<title>订阅通知面板</title>\n<style>\n*{margin:0;padding:0;box-sizing:border-box}body{font-family:-apple-system,BlinkMacSystemFont,Segoe UI,Roboto,sans-serif;background:#f1f5f9;color:#1e293b}\n.loading{min-height:100vh;display:flex;align-items:center;justify-content:center;background:linear-gradient(135deg,#667eea,#764ba2);flex-direction:column;color:#fff}\n.spinner{width:48px;height:48px;border:4px solid rgba(255,255,255,.3);border-top-color:#fff;border-radius:50%;animation:spin 1s linear infinite;margin-bottom:20px}@keyframes spin{to{transform:rotate(360deg)}}\n.login{min-height:100vh;display:flex;align-items:center;justify-content:center;background:linear-gradient(135deg,#667eea,#764ba2);padding:20px}\n.login-box{background:#fff;border-radius:16px;padding:40px;width:100%;max-width:400px;text-align:center;box-shadow:0 20px 60px rgba(0,0,0,.3)}\n.login-box .icon{font-size:48px;margin-bottom:16px}.login-box h1{font-size:24px;margin-bottom:8px}.login-box p{color:#64748b;margin-bottom:24px;font-size:14px}\n.form-group{margin-bottom:20px;text-align:left}.form-group label{display:block;margin-bottom:8px;font-weight:500;font-size:14px}\n.form-group input,.form-group select{width:100%;padding:12px;border:2px solid #e2e8f0;border-radius:8px;font-size:14px;outline:none}\n.form-group input:focus,.form-group select:focus{border-color:#6366f1}.btn{padding:12px 24px;border:none;border-radius:8px;font-size:14px;font-weight:500;cursor:pointer}\n.btn-primary{background:#6366f1;color:#fff;width:100%}.btn-primary:hover{background:#4f46e5}.btn-primary:disabled{opacity:.6}.error{color:#ef4444;font-size:14px;margin-top:12px}\n.navbar{background:linear-gradient(135deg,#667eea,#764ba2);color:#fff;padding:0 20px;height:60px;display:flex;align-items:center;justify-content:space-between;position:sticky;top:0;z-index:100}\n.navbar-brand h1{font-size:18px;font-weight:600}.navbar-actions{display:flex;gap:8px}\n.navbar-actions .btn{background:rgba(255,255,255,.2);color:#fff;padding:8px 16px;font-size:13px;border:1px solid rgba(255,255,255,.3)}\n.main{padding:20px;max-width:1200px;margin:0 auto}\n.time-cards{display:grid;grid-template-columns:repeat(3,1fr);gap:12px;margin-bottom:20px}\n.time-card{border-radius:12px;padding:16px;color:#fff;display:flex;flex-direction:column}\n.time-card.utc{background:linear-gradient(135deg,#3b82f6,#2563eb)}\n.time-card.cst{background:linear-gradient(135deg,#ef4444,#dc2626)}\n.time-card.et{background:linear-gradient(135deg,#8b5cf6,#7c3aed)}\n.time-card .label{font-size:12px;opacity:.8;margin-bottom:4px}.time-card .time{font-size:18px;font-weight:600}\n.action-cards{display:grid;grid-template-columns:repeat(3,1fr);gap:12px;margin-bottom:20px}\n.action-card{background:#fff;border-radius:12px;padding:16px;box-shadow:0 1px 3px rgba(0,0,0,.1);cursor:pointer;transition:all 0.2s;text-align:center;border:2px solid transparent}\n.action-card:hover{transform:translateY(-2px);box-shadow:0 4px 12px rgba(0,0,0,.15)}\n.action-card.add{border-color:#22c55e}.action-card.add:hover{background:#f0fdf4}\n.action-card.notify{border-color:#3b82f6}.action-card.notify:hover{background:#eff6ff}\n.action-card.test{border-color:#8b5cf6}.action-card.test:hover{background:#f5f3ff}\n.action-card .icon{font-size:32px;margin-bottom:8px}.action-card .label{font-size:14px;font-weight:500}\n.stats{display:grid;grid-template-columns:repeat(3,1fr);gap:16px;margin-bottom:20px}\n.stat{background:#fff;border-radius:12px;padding:20px;display:flex;align-items:center;gap:16px;box-shadow:0 1px 3px rgba(0,0,0,.1)}\n.stat-icon{width:48px;height:48px;border-radius:12px;display:flex;align-items:center;justify-content:center;font-size:24px}\n.stat-icon.blue{background:#dbeafe}.stat-icon.green{background:#dcfce7}.stat-icon.orange{background:#ffedd5}\n.stat h3{font-size:24px;font-weight:700}.stat p{font-size:14px;color:#64748b}\n.card{background:#fff;border-radius:12px;box-shadow:0 1px 3px rgba(0,0,0,.1);overflow:hidden}\n.card-header{padding:16px 20px;border-bottom:1px solid #e2e8f0;display:flex;justify-content:space-between;align-items:center}.card-header h2{font-size:16px;font-weight:600}\ntable{width:100%;border-collapse:collapse}th,td{padding:14px 20px;text-align:left;border-bottom:1px solid #e2e8f0;font-size:14px}\nth{background:#f8fafc;font-size:12px;font-weight:600;text-transform:uppercase;color:#64748b}tr:hover{background:#f8fafc}\n.badge{display:inline-block;padding:4px 10px;border-radius:20px;font-size:12px;font-weight:500}\n.badge-purple{background:#f3e8ff;color:#7c3aed}.badge-green{background:#dcfce7;color:#16a34a}.badge-red{background:#fee2e2;color:#dc2626}.badge-blue{background:#dbeafe;color:#2563eb}\n.actions{display:flex;gap:6px}.actions button{width:30px;height:30px;border:none;border-radius:6px;cursor:pointer;font-size:14px}\n.actions .edit{background:#dbeafe}.actions .toggle{background:#fef3c7}.actions .toggle.on{background:#dcfce7}.actions .del{background:#fee2e2}\n.empty{text-align:center;padding:60px 20px;color:#64748b}\n.modal{position:fixed;top:0;left:0;right:0;bottom:0;background:rgba(0,0,0,.5);display:flex;align-items:center;justify-content:center;z-index:1000;padding:20px}\n.modal-box{background:#fff;border-radius:16px;width:100%;max-width:500px;max-height:90vh;overflow-y:auto}\n.modal-header{padding:20px;border-bottom:1px solid #e2e8f0;display:flex;justify-content:space-between;align-items:center}\n.modal-header h3{font-size:18px;font-weight:600}.modal-close{width:32px;height:32px;border:none;background:#f1f5f9;border-radius:8px;cursor:pointer;font-size:18px}\n.modal-body{padding:20px}.modal-footer{padding:16px 20px;border-top:1px solid #e2e8f0;display:flex;justify-content:flex-end;gap:12px}\n.btn-cancel{background:#f1f5f9;color:#1e293b}\n.toast{position:fixed;bottom:20px;right:20px;padding:12px 20px;border-radius:8px;color:#fff;font-weight:500;z-index:2000}\n.toast.ok{background:#22c55e}.toast.err{background:#ef4444}\n.form-row{display:grid;grid-template-columns:1fr 1fr;gap:12px}\n@media(max-width:768px){.navbar{padding:0 12px}.main{padding:12px}.time-cards,.action-cards,.stats{grid-template-columns:1fr}th,td{padding:10px 12px;font-size:13px}.form-row{grid-template-columns:1fr}}\n</style>\n</head>\n<body>\n<div id="app">\n<div v-if="checking" class="loading"><div class="spinner"></div><p>加载中...</p></div>\n<div v-else-if="needLogin&&!logged" class="login">\n<div class="login-box">\n<div class="icon">&#128274;</div>\n<h1>订阅通知面板</h1>\n<p>请输入管理员密码登录</p>\n<form @submit.prevent="doLogin">\n<div class="form-group"><label>密码</label><input v-model="pwd" type="password" required autofocus></div>\n<button class="btn btn-primary" :disabled="logining">{{logining?\'登录中...\':\'登录\'}}</button>\n<p v-if="loginErr" class="error">{{loginErr}}</p>\n</form>\n</div>\n</div>\n<div v-else>\n<nav class="navbar">\n<div class="navbar-brand"><h1>订阅通知面板</h1></div>\n<div class="navbar-actions"><button v-if="needLogin" class="btn" @click="doLogout">退出</button></div>\n</nav>\n<main class="main">\n<div class="time-cards">\n<div class="time-card utc"><div class="label">世界协调时</div><div class="time">{{times.utc}}</div></div>\n<div class="time-card cst"><div class="label">北京时间</div><div class="time">{{times.cst}}</div></div>\n<div class="time-card et"><div class="label">美国东部</div><div class="time">{{times.et}}</div></div>\n</div>\n<div class="action-cards">\n<div class="action-card add" @click="openAdd"><div class="icon">+</div><div class="label">添加订阅</div></div>\n<div class="action-card notify" @click="doNotify"><div class="icon">↑</div><div class="label">立即通知</div></div>\n<div class="action-card test" @click="testBot"><div class="icon">B</div><div class="label">测试通知</div></div>\n</div>\n<div class="stats">\n<div class="stat"><div class="stat-icon blue">L</div><div><h3>{{subs.length}}</h3><p>总订阅</p></div></div>\n<div class="stat"><div class="stat-icon green">V</div><div><h3>{{active}}</h3><p>活跃</p></div></div>\n<div class="stat"><div class="stat-icon orange">T</div><div><h3>{{due}}</h3><p>待通知</p></div></div>\n</div>\n<div class="card">\n<div class="card-header"><h2>订阅列表</h2><span style="color:#64748b;font-size:14px">共 {{subs.length}} 个</span></div>\n<div v-if="loading" style="padding:40px;text-align:center"><p>加载中...</p></div>\n<div v-else-if="subs.length===0" class="empty"><p>暂无订阅</p></div>\n<table v-else>\n<thead><tr><th>名称</th><th>内容</th><th>周期</th><th>时区</th><th>下次通知</th><th>状态</th><th>操作</th></tr></thead>\n<tbody><tr v-for="s in subs" :key="s.id">\n<td><strong>{{s.name}}</strong></td>\n<td style="max-width:160px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">{{s.content}}</td>\n<td><span class="badge badge-purple">{{cycleLabel(s)}}</span></td>\n<td><span class="badge badge-blue">{{tzLabel(s.timezone)}}</span></td>\n<td>{{s.next_notify_date}} {{s.cycle_hour||\'09\'}}:00</td>\n<td><span :class="s.is_active?\'badge badge-green\':\'badge badge-red\'">{{s.is_active?\'活跃\':\'停用\'}}</span></td>\n<td class="actions"><button class="edit" @click="openEdit(s)">E</button><button :class="s.is_active?\'toggle\':\'toggle on\'" @click="toggle(s)">{{s.is_active?'||':'>'}}</button><button class="del" @click="del(s.id)">X</button></td>\n</tr></tbody>\n</table>\n</div>\n</main>\n</div>\n<div v-if="modal" class="modal" @click.self="modal=false">\n<div class="modal-box">\n<div class="modal-header"><h3>{{editId?\'编辑\':\'添加\'}}订阅</h3><button class="modal-close" @click="modal=false">X</button></div>\n<form @submit.prevent="save">\n<div class="modal-body">\n<div class="form-group"><label>名称 *</label><input v-model="form.name" required placeholder="订阅标题"></div>\n<div class="form-group"><label>内容 *</label><input v-model="form.content" required placeholder="订阅详情说明"></div>\n<div class="form-row">\n<div class="form-group"><label>周期类型 *</label><select v-model="form.cycle_type" required><option value="">请选择</option><option value="daily">每日</option><option value="weekly">每周</option><option value="monthly">每月</option><option value="yearly">每年</option><option value="specific">指定日期</option></select></div>\n<div class="form-group"><label>时区 *</label><select v-model="form.timezone" required><option value="UTC">世界协调 UTC</option><option value="CST">北京时间 CST</option><option value="ET">美国东部 ET</option></select></div>\n</div>\n<div class="form-row">\n<div v-if="form.cycle_type===\'weekly\'" class="form-group"><label>星期 *</label><select v-model="form.cycle_value" required><option value="">请选择</option><option value="1">周一</option><option value="2">周二</option><option value="3">周三</option><option value="4">周四</option><option value="5">周五</option><option value="6">周六</option><option value="7">周日</option></select></div>\n<div v-if="form.cycle_type===\'monthly\'" class="form-group"><label>日期 * (1-28)</label><input v-model="form.cycle_value" type="number" min="1" max="28" required></div>\n<div v-if="form.cycle_type===\'yearly\'" class="form-group"><label>月-日 *</label><input v-model="form.cycle_value" required placeholder="12-25"></div>\n<div v-if="form.cycle_type===\'specific\'" class="form-group"><label>日期 *</label><input v-model="form.cycle_value" type="date" required></div>\n<div class="form-group"><label>小时 * (0-23)</label><select v-model="form.cycle_hour" required><option v-for="h in 24" :key="h-1" :value="String(h-1).padStart(2,\'0\')">{{String(h-1).padStart(2,\'0\')}}:00</option></select></div>\n</div>\n</div>\n<div class="modal-footer"><button type="button" class="btn btn-cancel" @click="modal=false">取消</button><button type="submit" class="btn btn-primary" style="width:auto">保存</button></div>\n</form>\n</div>\n</div>\n<div v-if="toast.show" :class="\'toast \'+toast.type">{{toast.msg}}</div>\n</div>\n<script src="https://cdn.jsdelivr.net/npm/vue@3/dist/vue.global.prod.js"></script>\n<script>\nconst{createApp,ref,computed,onMounted,onUnmounted}=Vue;\ncreateApp({\nsetup(){\nconst checking=ref(true),needLogin=ref(false),logged=ref(false),pwd=ref(\'\'),logining=ref(false),loginErr=ref(\'\');\nconst subs=ref([]),loading=ref(false),modal=ref(false),editId=ref(null);\nconst form=ref({name:\'\',content:\'\',cycle_type:\'\',cycle_value:\'\',cycle_hour:\'09\',timezone:\'UTC\'});\nconst toast=ref({show:false,msg:\'\',type:\'ok\'});\nconst times=ref({utc:\'\',cst:\'\',et:\'\'});\nlet timer=null;\nconst active=computed(()=>subs.value.filter(s=>s.is_active).length);\nconst due=computed(()=>{const t=new Date().toISOString().split(\'T\')[0];const h=String(new Date().getUTCHours()).padStart(2,\'0\');return subs.value.filter(s=>s.is_active&&s.next_notify_date<=t&&s.cycle_hour<=h).length});\nconst show=(msg,type)=>{toast.value={show:true,msg,type:type||\'ok\'};setTimeout(()=>toast.value.show=false,3000)};\nconst updateClock=async()=>{try{const r=await fetch(\'/api/server-time\');if(r.ok)times.value=await r.json();}catch(e){}};\nconst api=async(url,opt)=>{opt=opt||{};const token=localStorage.getItem(\'token\');const h={\'Content-Type\':\'application/json\'};if(opt.headers)Object.assign(h,opt.headers);if(token)h[\'Authorization\']=\'Bearer \'+token;const r=await fetch(url,{method:opt.method||\'GET\',headers:h,body:opt.body});if(r.status===401){logged.value=false;throw new Error(\'401\');}return r;};\nconst check=async()=>{try{const r=await fetch(\'/api/auth/status\');if(r.ok){const d=await r.json();needLogin.value=d.requireAuth;if(needLogin.value){const t=localStorage.getItem(\'token\');if(t){const v=await(await fetch(\'/api/auth/verify\',{method:\'POST\',headers:{\'Content-Type\':\'application/json\'},body:JSON.stringify({token:t})})).json();logged.value=v.valid;if(!v.valid)localStorage.removeItem(\'token\');}else logged.value=false;}else logged.value=true;}if(logged.value)fetchSubs();}catch(e){logged.value=true;fetchSubs();}finally{checking.value=false;updateClock();timer=setInterval(updateClock,1000);}};\nonUnmounted(()=>{if(timer)clearInterval(timer)});\nconst doLogin=async()=>{logining.value=true;loginErr.value=\'\';try{const r=await fetch(\'/api/login\',{method:\'POST\',headers:{\'Content-Type\':\'application/json\'},body:JSON.stringify({password:pwd.value})});const d=await r.json();if(d.success){localStorage.setItem(\'token\',d.token);logged.value=true;show(\'登录成功\');fetchSubs();}else loginErr.value=d.error||\'密码错误\';}catch(e){loginErr.value=\'登录失败\';}finally{logining.value=false;}};\nconst doLogout=()=>{localStorage.removeItem(\'token\');logged.value=false;subs.value=[];};\nconst fetchSubs=async()=>{try{loading.value=true;const r=await api(\'/api/subscriptions\');if(r.ok)subs.value=await r.json();}catch(e){if(e.message!==\'401\')show(\'获取失败\',\'err\');}finally{loading.value=false;}};\nconst openAdd=()=>{editId.value=null;form.value={name:\'\',content:\'\',cycle_type:\'\',cycle_value:\'\',cycle_hour:\'09\',timezone:\'UTC\'};modal.value=true;};\nconst openEdit=s=>{editId.value=s.id;form.value={name:s.name,content:s.content,cycle_type:s.cycle_type,cycle_value:s.cycle_value,cycle_hour:s.cycle_hour||\'09\',timezone:s.timezone||\'UTC\'};modal.value=true;};\nconst save=async()=>{try{const url=editId.value?\'/api/subscriptions/\'+editId.value:\'/api/subscriptions\';const r=await api(url,{method:editId.value?\'PUT\':\'POST\',body:JSON.stringify(form.value)});if(r.ok){show(editId.value?\'更新成功\':\'添加成功\');modal.value=false;fetchSubs();}else{const d=await r.json();show(d.error||\'操作失败\',\'err\');}}catch(e){if(e.message!==\'401\')show(\'操作失败\',\'err\');}};\nconst del=async id=>{if(!confirm(\'确定删除？\'))return;try{const r=await api(\'/api/subscriptions/\'+id,{method:\'DELETE\'});if(r.ok){show(\'删除成功\');fetchSubs();}}catch(e){if(e.message!==\'401\')show(\'删除失败\',\'err\');}};\nconst toggle=async s=>{try{const r=await api(\'/api/subscriptions/\'+s.id,{method:\'PUT\',body:JSON.stringify({is_active:!s.is_active})});if(r.ok){show(s.is_active?\'已停用\':\'已启用\');fetchSubs();}}catch(e){if(e.message!==\'401\')show(\'操作失败\',\'err\');}};\nconst doNotify=async()=>{try{const r=await api(\'/api/notify\',{method:\'POST\'});if(r.ok){const d=await r.json();show(\'已发送\'+d.sent+\'条通知\');fetchSubs();}}catch(e){if(e.message!==\'401\')show(\'通知失败\',\'err\');}};\nconst testBot=async()=>{try{const r=await api(\'/api/test-telegram\',{method:\'POST\'});const d=await r.json();if(d.success){alert(\'测试通知发送成功！\\n\\n恭喜，Bot已经连接成功啦！\\n\\n发送 /help 或者 /start 查看可用命令\');}else{alert(\'测试通知发送失败！\\n\\n错误信息: \'+(d.error||d.message||\'未知错误\')+\'\\n\\n请检查:\\n1. TELEGRAM_BOT_TOKEN 是否正确\\n2. TELEGRAM_CHAT_ID 是否正确\\n3. 是否已向Bot发送过消息\');}}catch(e){alert(\'测试失败！\\n\\n网络错误，请检查网络连接后重试\');}};\nconst cycleLabel=s=>{const days=[\'\',\'一\',\'二\',\'三\',\'四\',\'五\',\'六\',\'日\'];return{daily:\'每日\',weekly:\'每周\'+days[parseInt(s.cycle_value)||1],monthly:\'每月\'+s.cycle_value+\'日\',yearly:\'每年\'+s.cycle_value,specific:s.cycle_value}[s.cycle_type]||s.cycle_type};\nconst tzLabel=tz=>({UTC:\'UTC\',CST:\'CST\',ET:\'ET\'}[tz]||tz);\nonMounted(check);\nreturn{checking,needLogin,logged,pwd,logining,loginErr,subs,loading,modal,editId,form,times,toast,active,due,doLogin,doLogout,openAdd,openEdit,save,del,toggle,doNotify,testBot,cycleLabel,tzLabel};\n}\n}).mount(\'#app\');\n</script>\n</body>\n</html>';
}