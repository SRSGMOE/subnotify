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
        await fetch('https://api.telegram.org/bot' + env.TELEGRAM_BOT_TOKEN + '/setMyCommands', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                commands: [
                    { command: 'start', description: 'Start' },
                    { command: 'help', description: 'Help' },
                    { command: 'list', description: 'List subscriptions' },
                    { command: 'today', description: 'Today notifications' },
                    { command: 'status', description: 'System status' }
                ]
            })
        });
    } catch (e) {}
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

async function handleAPI(request, env, path) {
    const method = request.method;
    const json = (data, status) => new Response(JSON.stringify(data), { status: status || 200 });
    
    if (!env.DB) return json({ error: 'DB not bound' }, 500);
    
    await initDB(env.DB);
    
    if (path === '/auth/status') return json({ requireAuth: !!env.ADMIN_PASSWORD });
    
    if (path === '/login' && method === 'POST') {
        const body = await request.json();
        if (!env.ADMIN_PASSWORD) return json({ success: true, token: 'no-auth' });
        if (body.password === env.ADMIN_PASSWORD) return json({ success: true, token: genToken(env.ADMIN_PASSWORD) });
        return json({ success: false, error: 'Wrong password' }, 401);
    }
    
    if (path === '/auth/verify' && method === 'POST') {
        const body = await request.json();
        if (!env.ADMIN_PASSWORD) return json({ valid: true });
        return json({ valid: body.token === genToken(env.ADMIN_PASSWORD) });
    }
    
    if (path === '/server-time') {
        const now = new Date();
        return json({ utc: formatTime(now, 'UTC'), cst: formatTime(now, 'CST'), et: formatTime(now, 'ET') });
    }
    
    if (env.ADMIN_PASSWORD) {
        const auth = request.headers.get('Authorization');
        const token = auth ? auth.replace('Bearer ', '') : '';
        if (token !== genToken(env.ADMIN_PASSWORD)) return json({ error: 'Unauthorized' }, 401);
    }
    
    if (path === '/test-telegram' && method === 'POST') {
        try {
            const res = await fetch('https://api.telegram.org/bot' + env.TELEGRAM_BOT_TOKEN + '/sendMessage', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    chat_id: env.TELEGRAM_CHAT_ID,
                    text: 'Bot connected! Send /help or /start'
                })
            });
            const data = await res.json();
            return json({ success: data.ok, message: data.description });
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
        if (!body.name || !body.content || !body.cycle_type || !body.timezone) return json({ error: 'All fields required' }, 400);
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
            return results.length ? json(results[0]) : json({ error: 'Not found' }, 404);
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
        const today = now.toISOString().split('T')[0];
        const hour = String(now.getUTCHours()).padStart(2, '0');
        const { results } = await env.DB.prepare('SELECT * FROM subscriptions WHERE next_notify_date<=? AND cycle_hour<=? AND is_active=1').bind(today, hour).all();
        let sent = 0;
        for (const sub of results) {
            try {
                if (env.TELEGRAM_BOT_TOKEN && env.TELEGRAM_CHAT_ID) await sendTelegram(env, sub);
                await env.DB.prepare('UPDATE subscriptions SET next_notify_date=? WHERE id=?').bind(calcNextDate(sub.cycle_type, sub.cycle_value, sub.cycle_hour, sub.timezone), sub.id).run();
                sent++;
            } catch (e) {}
        }
        return json({ checked: results.length, sent });
    }
    
    return json({ error: 'Not found' }, 404);
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
    } catch (e) {}
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
            const parts = (value || '1-1').split('-');
            const m = parseInt(parts[0]) || 1;
            const dy = Math.min(parseInt(parts[1]) || 1, 28);
            next.setUTCMonth(m - 1, dy);
            if (next <= now) next.setUTCFullYear(next.getUTCFullYear() + 1);
            break;
        case 'specific':
            return value;
    }
    return next.toISOString().split('T')[0];
}

async function sendTelegram(env, sub) {
    const days = ['', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
    const labels = { daily: 'Daily', weekly: 'Weekly ' + days[parseInt(sub.cycle_value) || 1], monthly: 'Monthly ' + sub.cycle_value, yearly: 'Yearly ' + sub.cycle_value, specific: sub.cycle_value };
    const tzLabels = { 'UTC': 'UTC', 'CST': 'CST (Beijing)', 'ET': 'ET (US East)' };
    const msg = 'Reminder\n\nName: ' + sub.name + '\nContent: ' + sub.content + '\nCycle: ' + (labels[sub.cycle_type] || sub.cycle_type) + ' ' + (sub.cycle_hour || '09') + ':00\nTimezone: ' + (tzLabels[sub.timezone] || sub.timezone) + '\nNext: ' + sub.next_notify_date;
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
        await send('Subscription Notifier Bot\n\nCommands:\n/start - Start\n/help - Help\n/list - List subscriptions\n/today - Today notifications\n/status - System status');
    } else if (text === '/list') {
        const { results } = await env.DB.prepare('SELECT * FROM subscriptions WHERE is_active=1').all();
        if (results.length === 0) await send('No subscriptions');
        else {
            let msg = 'Subscriptions:\n\n';
            results.forEach((s, i) => { msg += (i + 1) + '. ' + s.name + '\n   ' + s.content + '\n   ' + (s.timezone || 'UTC') + ' ' + s.next_notify_date + ' ' + (s.cycle_hour || '09') + ':00\n\n'; });
            await send(msg);
        }
    } else if (text === '/today') {
        const now = new Date();
        const today = now.toISOString().split('T')[0];
        const hour = String(now.getUTCHours()).padStart(2, '0');
        const { results } = await env.DB.prepare('SELECT * FROM subscriptions WHERE next_notify_date<=? AND cycle_hour<=? AND is_active=1').bind(today, hour).all();
        if (results.length === 0) await send('No notifications today');
        else {
            let msg = 'Today:\n\n';
            results.forEach((s, i) => { msg += (i + 1) + '. ' + s.name + ' ' + (s.cycle_hour || '09') + ':00 (' + (s.timezone || 'UTC') + ')\n'; });
            await send(msg);
        }
    } else if (text === '/status') {
        const { results: subs } = await env.DB.prepare('SELECT COUNT(*) as count FROM subscriptions WHERE is_active=1').all();
        const now = new Date();
        await send('Status\n\nUTC: ' + formatTime(now, 'UTC') + '\nBeijing: ' + formatTime(now, 'CST') + '\nUS East: ' + formatTime(now, 'ET') + '\nActive: ' + subs[0].count);
    }
    return new Response('OK');
}

function getHTML() {
    return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Subscription Notifier</title>
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
.actions .toggle{background:#fef3c7;color:#d97706}
.actions .toggle.on{background:#dcfce7;color:#16a34a}
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
.toast{position:fixed;bottom:20px;right:20px;padding:12px 20px;border-radius:8px;color:#fff;font-weight:500;z-index:2000}
.toast.ok{background:#22c55e}
.toast.err{background:#ef4444}
.form-row{display:grid;grid-template-columns:1fr 1fr;gap:12px}
@media(max-width:768px){.navbar{padding:0 12px}.main{padding:12px}.time-cards,.action-cards,.stats{grid-template-columns:1fr}th,td{padding:10px 12px;font-size:13px}.form-row{grid-template-columns:1fr}}
</style>
</head>
<body>
<div id="app">
<div v-if="checking" class="loading"><div class="spinner"></div><p>Loading...</p></div>
<div v-else-if="needLogin && !logged" class="login">
<div class="login-box">
<h1>Subscription Notifier</h1>
<p>Enter admin password to login</p>
<form @submit.prevent="doLogin">
<div class="form-group">
<label>Password</label>
<input v-model="pwd" type="password" required autofocus>
</div>
<button class="btn btn-primary" :disabled="logining">{{ logining ? 'Logging in...' : 'Login' }}</button>
<p v-if="loginErr" class="error">{{ loginErr }}</p>
</form>
</div>
</div>
<div v-else>
<nav class="navbar">
<h1>Subscription Notifier</h1>
<div><button v-if="needLogin" class="btn" @click="doLogout">Logout</button></div>
</nav>
<main class="main">
<div class="time-cards">
<div class="time-card utc"><div class="label">UTC Time</div><div class="time">{{ times.utc }}</div></div>
<div class="time-card cst"><div class="label">Beijing Time (CST)</div><div class="time">{{ times.cst }}</div></div>
<div class="time-card et"><div class="label">US East Time (ET)</div><div class="time">{{ times.et }}</div></div>
</div>
<div class="action-cards">
<div class="action-card add" @click="openAdd"><div class="icon">+</div><div class="label">Add Subscription</div></div>
<div class="action-card notify" @click="doNotify"><div class="icon">&uarr;</div><div class="label">Send Notification</div></div>
<div class="action-card test" @click="testBot"><div class="icon">T</div><div class="label">Test Bot</div></div>
</div>
<div class="stats">
<div class="stat"><div class="stat-icon blue">All</div><div><h3>{{ subs.length }}</h3><p>Total</p></div></div>
<div class="stat"><div class="stat-icon green">On</div><div><h3>{{ active }}</h3><p>Active</p></div></div>
<div class="stat"><div class="stat-icon orange">!</div><div><h3>{{ due }}</h3><p>Due</p></div></div>
</div>
<div class="card">
<div class="card-header"><h2>Subscriptions</h2><span style="color:#64748b;font-size:14px">Total: {{ subs.length }}</span></div>
<div v-if="loading" style="padding:40px;text-align:center"><p>Loading...</p></div>
<div v-else-if="subs.length === 0" class="empty"><p>No subscriptions yet</p></div>
<table v-else>
<thead><tr><th>Name</th><th>Content</th><th>Cycle</th><th>Timezone</th><th>Next</th><th>Status</th><th>Actions</th></tr></thead>
<tbody>
<tr v-for="s in subs" :key="s.id">
<td><strong>{{ s.name }}</strong></td>
<td style="max-width:160px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">{{ s.content }}</td>
<td><span class="badge badge-purple">{{ cycleLabel(s) }}</span></td>
<td><span class="badge badge-blue">{{ tzLabel(s.timezone) }}</span></td>
<td>{{ s.next_notify_date }} {{ s.cycle_hour || '09' }}:00</td>
<td><span :class="s.is_active ? 'badge badge-green' : 'badge badge-red'">{{ s.is_active ? 'Active' : 'Paused' }}</span></td>
<td class="actions">
<button class="edit" @click="openEdit(s)">Edit</button>
<button v-if="s.is_active" class="toggle" @click="toggle(s)">Pause</button>
<button v-else class="toggle on" @click="toggle(s)">Resume</button>
<button class="del" @click="del(s.id)">Delete</button>
</td>
</tr>
</tbody>
</table>
</div>
</main>
</div>
<div v-if="modal" class="modal" @click.self="modal = false">
<div class="modal-box">
<div class="modal-header"><h3>{{ editId ? 'Edit' : 'Add' }} Subscription</h3><button class="modal-close" @click="modal = false">X</button></div>
<form @submit.prevent="save">
<div class="modal-body">
<div class="form-group"><label>Name *</label><input v-model="form.name" required placeholder="Subscription name"></div>
<div class="form-group"><label>Content *</label><input v-model="form.content" required placeholder="Description"></div>
<div class="form-row">
<div class="form-group"><label>Cycle *</label><select v-model="form.cycle_type" required><option value="">Select</option><option value="daily">Daily</option><option value="weekly">Weekly</option><option value="monthly">Monthly</option><option value="yearly">Yearly</option><option value="specific">Specific Date</option></select></div>
<div class="form-group"><label>Timezone *</label><select v-model="form.timezone" required><option value="UTC">UTC</option><option value="CST">Beijing (CST)</option><option value="ET">US East (ET)</option></select></div>
</div>
<div class="form-row">
<div v-if="form.cycle_type === 'weekly'" class="form-group"><label>Day *</label><select v-model="form.cycle_value" required><option value="">Select</option><option value="1">Monday</option><option value="2">Tuesday</option><option value="3">Wednesday</option><option value="4">Thursday</option><option value="5">Friday</option><option value="6">Saturday</option><option value="7">Sunday</option></select></div>
<div v-if="form.cycle_type === 'monthly'" class="form-group"><label>Day (1-28) *</label><input v-model="form.cycle_value" type="number" min="1" max="28" required></div>
<div v-if="form.cycle_type === 'yearly'" class="form-group"><label>Month-Day *</label><input v-model="form.cycle_value" required placeholder="MM-DD"></div>
<div v-if="form.cycle_type === 'specific'" class="form-group"><label>Date *</label><input v-model="form.cycle_value" type="date" required></div>
<div class="form-group"><label>Hour (0-23) *</label><select v-model="form.cycle_hour" required><option v-for="h in 24" :key="h-1" :value="String(h-1).padStart(2,'0')">{{ String(h-1).padStart(2,'0') }}:00</option></select></div>
</div>
</div>
<div class="modal-footer"><button type="button" class="btn btn-cancel" @click="modal = false">Cancel</button><button type="submit" class="btn btn-primary" style="width:auto">Save</button></div>
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
const form = ref({ name: '', content: '', cycle_type: '', cycle_value: '', cycle_hour: '09', timezone: 'UTC' });
const toast = ref({ show: false, msg: '', type: 'ok' });
const times = ref({ utc: '', cst: '', et: '' });
let timer = null;
const active = computed(() => subs.value.filter(s => s.is_active).length);
const due = computed(() => {
const t = new Date().toISOString().split('T')[0];
const h = String(new Date().getUTCHours()).padStart(2, '0');
return subs.value.filter(s => s.is_active && s.next_notify_date <= t && s.cycle_hour <= h).length;
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
onUnmounted(() => { if (timer) clearInterval(timer); });
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
show('Login success');
fetchSubs();
} else {
loginErr.value = d.error || 'Wrong password';
}
} catch (e) {
loginErr.value = 'Login failed';
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
if (e.message !== '401') show('Failed to load', 'err');
} finally {
loading.value = false;
}
};
const openAdd = () => {
editId.value = null;
form.value = { name: '', content: '', cycle_type: '', cycle_value: '', cycle_hour: '09', timezone: 'UTC' };
modal.value = true;
};
const openEdit = (s) => {
editId.value = s.id;
form.value = { name: s.name, content: s.content, cycle_type: s.cycle_type, cycle_value: s.cycle_value, cycle_hour: s.cycle_hour || '09', timezone: s.timezone || 'UTC' };
modal.value = true;
};
const save = async () => {
try {
const url = editId.value ? '/api/subscriptions/' + editId.value : '/api/subscriptions';
const r = await api(url, { method: editId.value ? 'PUT' : 'POST', body: JSON.stringify(form.value) });
if (r.ok) {
show(editId.value ? 'Updated' : 'Added');
modal.value = false;
fetchSubs();
} else {
const d = await r.json();
show(d.error || 'Failed', 'err');
}
} catch (e) {
if (e.message !== '401') show('Failed', 'err');
}
};
const del = async (id) => {
if (!confirm('Delete this subscription?')) return;
try {
const r = await api('/api/subscriptions/' + id, { method: 'DELETE' });
if (r.ok) {
show('Deleted');
fetchSubs();
}
} catch (e) {
if (e.message !== '401') show('Failed', 'err');
}
};
const toggle = async (s) => {
try {
const r = await api('/api/subscriptions/' + s.id, {
method: 'PUT',
body: JSON.stringify({ is_active: !s.is_active })
});
if (r.ok) {
show(s.is_active ? 'Paused' : 'Resumed');
fetchSubs();
}
} catch (e) {
if (e.message !== '401') show('Failed', 'err');
}
};
const doNotify = async () => {
try {
const r = await api('/api/notify', { method: 'POST' });
if (r.ok) {
const d = await r.json();
show('Sent ' + d.sent + ' notifications');
fetchSubs();
}
} catch (e) {
if (e.message !== '401') show('Failed', 'err');
}
};
const testBot = async () => {
try {
const r = await api('/api/test-telegram', { method: 'POST' });
const d = await r.json();
if (d.success) {
alert('Test sent successfully!\\n\\nCheck your Telegram for the message.\\n\\nSend /help or /start to see commands.');
} else {
alert('Test failed!\\n\\nError: ' + (d.error || d.message || 'Unknown') + '\\n\\nPlease check:\\n1. TELEGRAM_BOT_TOKEN\\n2. TELEGRAM_CHAT_ID\\n3. You have messaged the bot first');
}
} catch (e) {
alert('Test failed!\\n\\nNetwork error. Please try again.');
}
};
const cycleLabel = (s) => {
const days = ['', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
const labels = {
daily: 'Daily',
weekly: 'Weekly ' + days[parseInt(s.cycle_value) || 1],
monthly: 'Monthly ' + s.cycle_value,
yearly: 'Yearly ' + s.cycle_value,
specific: s.cycle_value
};
return labels[s.cycle_type] || s.cycle_type;
};
const tzLabel = (tz) => {
const labels = { UTC: 'UTC', CST: 'CST', ET: 'ET' };
return labels[tz] || tz;
};
onMounted(check);
return {
checking, needLogin, logged, pwd, logining, loginErr,
subs, loading, modal, editId, form, times, toast,
active, due,
doLogin, doLogout, openAdd, openEdit, save, del, toggle, doNotify, testBot,
cycleLabel, tzLabel
};
}
}).mount('#app');
</script>
</body>
</html>`;
}