// Cloudflare Pages Functions - API 路由处理
// 这个文件会自动处理 /api/* 路径的请求

export async function onRequest(context) {
    const { request, env } = context;
    const url = new URL(request.url);
    const path = url.pathname;
    
    // 设置 CORS
    const corsHeaders = {
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS',
        'Access-Control-Allow-Headers': 'Content-Type, Authorization',
    };
    
    if (request.method === 'OPTIONS') {
        return new Response(null, { headers: corsHeaders });
    }
    
    try {
        // 初始化数据库（如果需要）
        await initializeDatabase(env.DB);
        
        // 路由处理
        const response = await handleRoute(request, env, path);
        
        // 添加 CORS 头
        const newResponse = new Response(response.body, response);
        Object.entries(corsHeaders).forEach(([key, value]) => {
            newResponse.headers.set(key, value);
        });
        
        return newResponse;
    } catch (error) {
        return new Response(JSON.stringify({ error: error.message }), {
            status: 500,
            headers: { ...corsHeaders, 'Content-Type': 'application/json' }
        });
    }
}

// 数据库初始化
async function initializeDatabase(db) {
    const { results } = await db.prepare(
        "SELECT name FROM sqlite_master WHERE type='table' AND name='subscriptions'"
    ).all();
    
    if (results.length === 0) {
        const sql = `
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
                status TEXT DEFAULT 'success',
                FOREIGN KEY (subscription_id) REFERENCES subscriptions(id)
            );
        `;
        
        const statements = sql.split(';').filter(s => s.trim());
        for (const stmt of statements) {
            await db.prepare(stmt).run();
        }
    }
}

// 路由处理
async function handleRoute(request, env, path) {
    const method = request.method;
    
    // 认证相关路由（不需要密码）
    if (path === '/api/auth/status') {
        return Response.json({ requireAuth: !!env.ADMIN_PASSWORD });
    }
    
    if (path === '/api/login' && method === 'POST') {
        const { password } = await request.json();
        
        if (!env.ADMIN_PASSWORD) {
            return Response.json({ success: true, token: 'no-auth' });
        }
        
        if (password === env.ADMIN_PASSWORD) {
            return Response.json({ 
                success: true, 
                token: generateToken(env.ADMIN_PASSWORD) 
            });
        }
        
        return Response.json({ success: false, error: '密码错误' }, { status: 401 });
    }
    
    if (path === '/api/auth/verify' && method === 'POST') {
        const { token } = await request.json();
        
        if (!env.ADMIN_PASSWORD) {
            return Response.json({ valid: true });
        }
        
        return Response.json({ valid: verifyToken(token, env.ADMIN_PASSWORD) });
    }
    
    if (path === '/api/health') {
        return Response.json({ status: 'ok', timestamp: new Date().toISOString() });
    }
    
    // 其他 API 路由需要认证
    if (!env.ADMIN_PASSWORD || verifyAuth(request, env.ADMIN_PASSWORD)) {
        return await handleApiRoute(request, env, path, method);
    }
    
    return Response.json({ error: '未授权' }, { status: 401 });
}

// 验证认证
function verifyAuth(request, password) {
    const authHeader = request.headers.get('Authorization');
    const token = authHeader?.replace('Bearer ', '');
    return verifyToken(token, password);
}

// 生成 token
function generateToken(password) {
    let hash = 0;
    for (let i = 0; i < password.length; i++) {
        const char = password.charCodeAt(i);
        hash = ((hash << 5) - hash) + char;
        hash = hash & hash;
    }
    return `auth_${Math.abs(hash).toString(36)}`;
}

// 验证 token
function verifyToken(token, password) {
    if (!token || !password) return false;
    return token === generateToken(password);
}

// 处理 API 路由
async function handleApiRoute(request, env, path, method) {
    const db = env.DB;
    
    // 获取所有订阅
    if (path === '/api/subscriptions' && method === 'GET') {
        const { results } = await db.prepare(
            'SELECT * FROM subscriptions ORDER BY next_notify_date ASC'
        ).all();
        return Response.json(results);
    }
    
    // 创建订阅
    if (path === '/api/subscriptions' && method === 'POST') {
        const { name, content, cycle_type, cycle_value } = await request.json();
        
        if (!name || !cycle_type) {
            return Response.json({ error: '名称和周期类型必填' }, { status: 400 });
        }
        
        const nextDate = calculateNextDate(cycle_type, cycle_value);
        
        await db.prepare(
            'INSERT INTO subscriptions (name, content, cycle_type, cycle_value, next_notify_date) VALUES (?, ?, ?, ?, ?)'
        ).bind(name, content || '', cycle_type, cycle_value || '', nextDate).run();
        
        return Response.json({ success: true }, { status: 201 });
    }
    
    // 单个订阅操作
    const subMatch = path.match(/^\/api\/subscriptions\/(\d+)$/);
    if (subMatch) {
        const id = subMatch[1];
        
        if (method === 'GET') {
            const { results } = await db.prepare('SELECT * FROM subscriptions WHERE id = ?').bind(id).all();
            if (results.length === 0) return Response.json({ error: '不存在' }, { status: 404 });
            return Response.json(results[0]);
        }
        
        if (method === 'PUT') {
            const body = await request.json();
            let query = 'UPDATE subscriptions SET updated_at = datetime(\'now\')';
            const params = [];
            
            if (body.name !== undefined) { query += ', name = ?'; params.push(body.name); }
            if (body.content !== undefined) { query += ', content = ?'; params.push(body.content); }
            if (body.cycle_type !== undefined) { query += ', cycle_type = ?'; params.push(body.cycle_type); }
            if (body.cycle_value !== undefined) { query += ', cycle_value = ?'; params.push(body.cycle_value); }
            if (body.cycle_type) { query += ', next_notify_date = ?'; params.push(calculateNextDate(body.cycle_type, body.cycle_value)); }
            if (body.is_active !== undefined) { query += ', is_active = ?'; params.push(body.is_active ? 1 : 0); }
            
            query += ' WHERE id = ?';
            params.push(id);
            
            await db.prepare(query).bind(...params).run();
            return Response.json({ success: true });
        }
        
        if (method === 'DELETE') {
            await db.prepare('DELETE FROM subscriptions WHERE id = ?').bind(id).run();
            return Response.json({ success: true });
        }
    }
    
    // 触发通知
    if (path === '/api/notify' && method === 'POST') {
        return Response.json({ message: '通知功能需要通过 Cron 触发' });
    }
    
    return Response.json({ error: '未找到路由' }, { status: 404 });
}

// 计算下次通知日期
function calculateNextDate(type, value) {
    const now = new Date();
    const next = new Date();
    
    switch (type) {
        case 'daily':
            next.setDate(now.getDate() + 1);
            break;
        case 'weekly':
            const day = parseInt(value) || 1;
            const current = now.getDay() || 7;
            next.setDate(now.getDate() + ((day - current + 7) % 7 || 7));
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