// Cloudflare Pages Functions - API 路由处理

export async function onRequest(context) {
    const { request, env } = context;
    const url = new URL(request.url);
    const path = url.pathname.replace(/^\/api/, '') || '/';
    
    // CORS 头
    const corsHeaders = {
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS',
        'Access-Control-Allow-Headers': 'Content-Type, Authorization',
        'Content-Type': 'application/json'
    };
    
    if (request.method === 'OPTIONS') {
        return new Response(null, { headers: corsHeaders });
    }
    
    try {
        // 检查数据库绑定
        if (!env.DB) {
            return new Response(JSON.stringify({ 
                error: '数据库未绑定',
                message: '请在 Cloudflare Dashboard → Settings → Functions → D1 Database Bindings 中绑定数据库，变量名必须是 DB'
            }), { status: 500, headers: corsHeaders });
        }
        
        // 初始化数据库
        await initDB(env.DB);
        
        // 处理请求
        const response = await handleRequest(request, env, path);
        
        // 添加 CORS 头
        const newHeaders = { ...corsHeaders };
        response.headers.forEach((value, key) => {
            newHeaders[key] = value;
        });
        
        return new Response(response.body, {
            status: response.status,
            headers: newHeaders
        });
    } catch (error) {
        return new Response(JSON.stringify({ 
            error: error.message,
            stack: error.stack 
        }), { status: 500, headers: corsHeaders });
    }
}

// 初始化数据库表
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
                    content TEXT,
                    cycle_type TEXT NOT NULL,
                    cycle_value TEXT,
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
        }
    } catch (e) {
        console.error('DB init error:', e);
    }
}

// 处理请求路由
async function handleRequest(request, env, path) {
    const method = request.method;
    const json = (data, status = 200) => new Response(JSON.stringify(data), { 
        status, 
        headers: { 'Content-Type': 'application/json' } 
    });
    
    // 认证相关路由 - 不需要密码
    if (path === '/auth/status') {
        return json({ requireAuth: !!env.ADMIN_PASSWORD });
    }
    
    if (path === '/login' && method === 'POST') {
        const body = await request.json();
        
        if (!env.ADMIN_PASSWORD) {
            return json({ success: true, token: 'no-auth-required' });
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
    
    if (path === '/health') {
        return json({ status: 'ok', db: !!env.DB, auth: !!env.ADMIN_PASSWORD });
    }
    
    // 以下路由需要认证
    if (env.ADMIN_PASSWORD) {
        const authHeader = request.headers.get('Authorization');
        const token = authHeader?.replace('Bearer ', '');
        
        if (token !== generateToken(env.ADMIN_PASSWORD)) {
            return json({ error: '未授权' }, 401);
        }
    }
    
    // 获取所有订阅
    if (path === '/subscriptions' && method === 'GET') {
        const { results } = await env.DB.prepare(
            'SELECT * FROM subscriptions ORDER BY next_notify_date ASC'
        ).all();
        return json(results);
    }
    
    // 创建订阅
    if (path === '/subscriptions' && method === 'POST') {
        const body = await request.json();
        
        if (!body.name || !body.cycle_type) {
            return json({ error: '名称和周期类型必填' }, 400);
        }
        
        const nextDate = calcNextDate(body.cycle_type, body.cycle_value);
        
        const result = await env.DB.prepare(
            'INSERT INTO subscriptions (name, content, cycle_type, cycle_value, next_notify_date) VALUES (?, ?, ?, ?, ?)'
        ).bind(body.name, body.content || '', body.cycle_type, body.cycle_value || '', nextDate).run();
        
        return json({ success: true, id: result.meta?.last_row_id }, 201);
    }
    
    // 单个订阅操作
    const subMatch = path.match(/^\/subscriptions\/(\d+)$/);
    if (subMatch) {
        const id = subMatch[1];
        
        // 获取单个
        if (method === 'GET') {
            const { results } = await env.DB.prepare('SELECT * FROM subscriptions WHERE id = ?').bind(id).all();
            return results.length ? json(results[0]) : json({ error: '不存在' }, 404);
        }
        
        // 更新
        if (method === 'PUT') {
            const body = await request.json();
            let query = 'UPDATE subscriptions SET updated_at = datetime(\'now\')';
            const params = [];
            
            if (body.name !== undefined) { query += ', name = ?'; params.push(body.name); }
            if (body.content !== undefined) { query += ', content = ?'; params.push(body.content); }
            if (body.cycle_type !== undefined) { query += ', cycle_type = ?'; params.push(body.cycle_type); }
            if (body.cycle_value !== undefined) { query += ', cycle_value = ?'; params.push(body.cycle_value); }
            if (body.is_active !== undefined) { query += ', is_active = ?'; params.push(body.is_active ? 1 : 0); }
            if (body.cycle_type) { query += ', next_notify_date = ?'; params.push(calcNextDate(body.cycle_type, body.cycle_value)); }
            
            query += ' WHERE id = ?';
            params.push(id);
            
            await env.DB.prepare(query).bind(...params).run();
            return json({ success: true });
        }
        
        // 删除
        if (method === 'DELETE') {
            await env.DB.prepare('DELETE FROM subscriptions WHERE id = ?').bind(id).run();
            return json({ success: true });
        }
    }
    
    // 触发通知
    if (path === '/notify' && method === 'POST') {
        const today = new Date().toISOString().split('T')[0];
        const { results } = await env.DB.prepare(
            'SELECT * FROM subscriptions WHERE next_notify_date <= ? AND is_active = 1'
        ).bind(today).all();
        
        let sent = 0;
        for (const sub of results) {
            try {
                if (env.TELEGRAM_BOT_TOKEN && env.TELEGRAM_CHAT_ID) {
                    await sendTelegram(env, sub);
                }
                const nextDate = calcNextDate(sub.cycle_type, sub.cycle_value);
                await env.DB.prepare('UPDATE subscriptions SET next_notify_date = ? WHERE id = ?')
                    .bind(nextDate, sub.id).run();
                await env.DB.prepare('INSERT INTO notifications (subscription_id, status) VALUES (?, ?)')
                    .bind(sub.id, 'success').run();
                sent++;
            } catch (e) {
                await env.DB.prepare('INSERT INTO notifications (subscription_id, status) VALUES (?, ?)')
                    .bind(sub.id, 'failed: ' + e.message).run();
            }
        }
        
        return json({ checked: results.length, sent });
    }
    
    return json({ error: '未找到路由' }, 404);
}

// 生成 token
function generateToken(password) {
    let hash = 0;
    for (let i = 0; i < password.length; i++) {
        hash = ((hash << 5) - hash) + password.charCodeAt(i);
        hash = hash & hash;
    }
    return 'auth_' + Math.abs(hash).toString(36);
}

// 计算下次日期
function calcNextDate(type, value) {
    const now = new Date();
    const next = new Date();
    
    switch (type) {
        case 'daily':
            next.setDate(now.getDate() + 1);
            break;
        case 'weekly':
            const day = parseInt(value) || 1;
            const curr = now.getDay() || 7;
            next.setDate(now.getDate() + ((day - curr + 7) % 7 || 7));
            break;
        case 'monthly':
            next.setDate(parseInt(value) || 1);
            if (next <= now) next.setMonth(next.getMonth() + 1);
            break;
        case 'yearly':
            const [m, d] = (value || '1-1').split('-').map(Number);
            next.setMonth(m - 1, d);
            if (next <= now) next.setFullYear(next.getFullYear() + 1);
            break;
        case 'specific':
            return value;
    }
    return next.toISOString().split('T')[0];
}

// 发送 Telegram 通知
async function sendTelegram(env, sub) {
    const labels = { daily: '每日', weekly: '每周', monthly: '每月', yearly: '每年', specific: '指定日期' };
    const msg = `🔔 订阅提醒\n\n📌 ${sub.name}\n📝 ${sub.content || '无'}\n📅 ${labels[sub.cycle_type] || sub.cycle_type}\n⏰ 下次: ${sub.next_notify_date}`;
    
    const res = await fetch(`https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/sendMessage`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ chat_id: env.TELEGRAM_CHAT_ID, text: msg })
    });
    
    if (!res.ok) throw new Error('Telegram 发送失败');
}