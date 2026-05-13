// Cloudflare Worker - 订阅通知面板
// 通过 GitHub 部署，敏感配置在 Dashboard 设置

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
            // 调试接口（无需认证）
            if (path === '/api/debug') {
                return new Response(JSON.stringify({
                    hasDB: !!env.DB,
                    hasToken: !!env.TELEGRAM_BOT_TOKEN,
                    hasChatId: !!env.TELEGRAM_CHAT_ID,
                    hasPassword: !!env.ADMIN_PASSWORD,
                    tokenPrefix: env.TELEGRAM_BOT_TOKEN ? env.TELEGRAM_BOT_TOKEN.substring(0, 10) + '...' : '未设置',
                    chatId: env.TELEGRAM_CHAT_ID || '未设置'
                }, null, 2), { headers: { 'Content-Type': 'application/json' } });
            }
            
            // 首页
            if (path === '/' || path === '/index.html') {
                return new Response(getHTML(), {
                    headers: { 'Content-Type': 'text/html;charset=utf-8' }
                });
            }
            
            // API
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
    }
};

async function handleAPI(request, env, path) {
    const method = request.method;
    const json = (data, status = 200) => new Response(JSON.stringify(data), { status });
    
    if (!env.DB) {
        return json({ error: '请在 Worker Settings → Variables → D1 Database Bindings 中绑定数据库（变量名: DB）' }, 500);
    }
    
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
    
    if (path === '/health') return json({ status: 'ok', db: !!env.DB });
    
    // 需要认证
    if (env.ADMIN_PASSWORD) {
        const auth = request.headers.get('Authorization')?.replace('Bearer ', '');
        if (auth !== genToken(env.ADMIN_PASSWORD)) return json({ error: '未授权' }, 401);
    }
    
    if (path === '/subscriptions' && method === 'GET') {
        const { results } = await env.DB.prepare('SELECT * FROM subscriptions ORDER BY next_notify_date').all();
        return json(results);
    }
    
    if (path === '/subscriptions' && method === 'POST') {
        const body = await request.json();
        if (!body.name || !body.cycle_type) return json({ error: '名称和周期必填' }, 400);
        const nextDate = calcNextDate(body.cycle_type, body.cycle_value);
        await env.DB.prepare('INSERT INTO subscriptions (name,content,cycle_type,cycle_value,next_notify_date) VALUES (?,?,?,?,?)')
            .bind(body.name, body.content || '', body.cycle_type, body.cycle_value || '', nextDate).run();
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
            let sql = 'UPDATE subscriptions SET updated_at=datetime(\'now\')';
            const p = [];
            if (body.name !== undefined) { sql += ',name=?'; p.push(body.name); }
            if (body.content !== undefined) { sql += ',content=?'; p.push(body.content); }
            if (body.cycle_type !== undefined) { sql += ',cycle_type=?'; p.push(body.cycle_type); }
            if (body.cycle_value !== undefined) { sql += ',cycle_value=?'; p.push(body.cycle_value); }
            if (body.is_active !== undefined) { sql += ',is_active=?'; p.push(body.is_active ? 1 : 0); }
            if (body.cycle_type) { sql += ',next_notify_date=?'; p.push(calcNextDate(body.cycle_type, body.cycle_value)); }
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
        const today = new Date().toISOString().split('T')[0];
        const { results } = await env.DB.prepare('SELECT * FROM subscriptions WHERE next_notify_date<=? AND is_active=1').bind(today).all();
        let sent = 0;
        for (const sub of results) {
            try {
                if (env.TELEGRAM_BOT_TOKEN && env.TELEGRAM_CHAT_ID) await sendTelegram(env, sub);
                await env.DB.prepare('UPDATE subscriptions SET next_notify_date=? WHERE id=?').bind(calcNextDate(sub.cycle_type, sub.cycle_value), sub.id).run();
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
            await db.exec(`CREATE TABLE IF NOT EXISTS subscriptions (id INTEGER PRIMARY KEY AUTOINCREMENT,name TEXT NOT NULL,content TEXT,cycle_type TEXT NOT NULL,cycle_value TEXT,next_notify_date TEXT NOT NULL,created_at TEXT DEFAULT (datetime('now')),updated_at TEXT DEFAULT (datetime('now')),is_active INTEGER DEFAULT 1);CREATE TABLE IF NOT EXISTS notifications (id INTEGER PRIMARY KEY AUTOINCREMENT,subscription_id INTEGER NOT NULL,sent_at TEXT DEFAULT (datetime('now')),status TEXT DEFAULT 'success');`);
        }
    } catch (e) { console.error(e); }
}

function genToken(pwd) { let h = 0; for (let i = 0; i < pwd.length; i++) h = ((h << 5) - h) + pwd.charCodeAt(i); return 'auth_' + Math.abs(h).toString(36); }

function calcNextDate(type, value) {
    const now = new Date(), next = new Date();
    switch (type) {
        case 'daily': next.setDate(now.getDate() + 1); break;
        case 'weekly': const d = parseInt(value) || 1, c = now.getDay() || 7; next.setDate(now.getDate() + ((d - c + 7) % 7 || 7)); break;
        case 'monthly': next.setDate(parseInt(value) || 1); if (next <= now) next.setMonth(next.getMonth() + 1); break;
        case 'yearly': const [m, dy] = (value || '1-1').split('-').map(Number); next.setMonth(m - 1, dy); if (next <= now) next.setFullYear(next.getFullYear() + 1); break;
        case 'specific': return value;
    }
    return next.toISOString().split('T')[0];
}

async function sendTelegram(env, sub) {
    const msg = `🔔 订阅提醒\n\n📌 ${sub.name}\n📝 ${sub.content || '无'}\n⏰ 下次: ${sub.next_notify_date}`;
    await fetch(`https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/sendMessage`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ chat_id: env.TELEGRAM_CHAT_ID, text: msg })
    });
}

async function handleTelegram(request, env) {
    if (request.method !== 'POST') return new Response('OK');
    const update = await request.json();
    if (!update.message?.text) return new Response('OK');
    const chatId = update.message.chat.id;
    const text = update.message.text;
    const send = async (msg) => {
        await fetch(`https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/sendMessage`, {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ chat_id: chatId, text: msg })
        });
    };
    if (text === '/start' || text === '/help') {
        await send('🔔 订阅通知机器人\n\n命令:\n/list - 查看订阅\n/today - 今日待通知\n/help - 帮助');
    } else if (text === '/list') {
        const { results } = await env.DB.prepare('SELECT * FROM subscriptions WHERE is_active=1').all();
        if (results.length === 0) await send('暂无订阅');
        else { let msg = '📋 订阅列表:\n\n'; results.forEach((s, i) => msg += `${i + 1}. ${s.name} - ${s.next_notify_date}\n`); await send(msg); }
    } else if (text === '/today') {
        const today = new Date().toISOString().split('T')[0];
        const { results } = await env.DB.prepare('SELECT * FROM subscriptions WHERE next_notify_date<=? AND is_active=1').bind(today).all();
        if (results.length === 0) await send('✅ 今日无待通知');
        else { let msg = '🔔 今日待通知:\n\n'; results.forEach((s, i) => msg += `${i + 1}. ${s.name}\n`); await send(msg); }
    }
    return new Response('OK');
}

function getHTML() {
    return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>订阅通知面板</title>
<style>
*{margin:0;padding:0;box-sizing:border-box}body{font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;background:#f1f5f9;color:#1e293b}
.loading{min-height:100vh;display:flex;align-items:center;justify-content:center;background:linear-gradient(135deg,#667eea,#764ba2);flex-direction:column;color:#fff}
.spinner{width:48px;height:48px;border:4px solid rgba(255,255,255,.3);border-top-color:#fff;border-radius:50%;animation:spin 1s linear infinite;margin-bottom:20px}@keyframes spin{to{transform:rotate(360deg)}}
.login{min-height:100vh;display:flex;align-items:center;justify-content:center;background:linear-gradient(135deg,#667eea,#764ba2);padding:20px}
.login-box{background:#fff;border-radius:16px;padding:40px;width:100%;max-width:400px;text-align:center;box-shadow:0 20px 60px rgba(0,0,0,.3)}
.login-box .icon{font-size:48px;margin-bottom:16px}.login-box h1{font-size:24px;margin-bottom:8px}.login-box p{color:#64748b;margin-bottom:24px;font-size:14px}
.form-group{margin-bottom:20px;text-align:left}.form-group label{display:block;margin-bottom:8px;font-weight:500;font-size:14px}
.form-group input,.form-group select{width:100%;padding:12px;border:2px solid #e2e8f0;border-radius:8px;font-size:14px;outline:none}
.form-group input:focus{border-color:#6366f1}.btn{padding:12px 24px;border:none;border-radius:8px;font-size:14px;font-weight:500;cursor:pointer}
.btn-primary{background:#6366f1;color:#fff;width:100%}.btn-primary:hover{background:#4f46e5}.btn-primary:disabled{opacity:.6}.error{color:#ef4444;font-size:14px;margin-top:12px}
.navbar{background:linear-gradient(135deg,#667eea,#764ba2);color:#fff;padding:0 20px;height:60px;display:flex;align-items:center;justify-content:space-between;position:sticky;top:0;z-index:100}
.navbar h1{font-size:18px;font-weight:600}.navbar-actions{display:flex;gap:8px}.navbar-actions .btn{background:rgba(255,255,255,.2);color:#fff;padding:8px 16px;font-size:13px;border:1px solid rgba(255,255,255,.3)}
.main{padding:20px;max-width:1200px;margin:0 auto}.stats{display:grid;grid-template-columns:repeat(auto-fit,minmax(200px,1fr));gap:16px;margin-bottom:20px}
.stat{background:#fff;border-radius:12px;padding:20px;display:flex;align-items:center;gap:16px;box-shadow:0 1px 3px rgba(0,0,0,.1)}
.stat-icon{width:48px;height:48px;border-radius:12px;display:flex;align-items:center;justify-content:center;font-size:24px}
.stat-icon.blue{background:#dbeafe}.stat-icon.green{background:#dcfce7}.stat-icon.orange{background:#ffedd5}
.stat h3{font-size:24px;font-weight:700}.stat p{font-size:14px;color:#64748b}
.card{background:#fff;border-radius:12px;box-shadow:0 1px 3px rgba(0,0,0,.1);overflow:hidden}
.card-header{padding:16px 20px;border-bottom:1px solid #e2e8f0;display:flex;justify-content:space-between;align-items:center}.card-header h2{font-size:16px;font-weight:600}
table{width:100%;border-collapse:collapse}th,td{padding:14px 20px;text-align:left;border-bottom:1px solid #e2e8f0;font-size:14px}
th{background:#f8fafc;font-size:12px;font-weight:600;text-transform:uppercase;color:#64748b}tr:hover{background:#f8fafc}
.badge{display:inline-block;padding:4px 10px;border-radius:20px;font-size:12px;font-weight:500}
.badge-purple{background:#f3e8ff;color:#7c3aed}.badge-green{background:#dcfce7;color:#16a34a}.badge-red{background:#fee2e2;color:#dc2626}
.actions{display:flex;gap:6px}.actions button{width:30px;height:30px;border:none;border-radius:6px;cursor:pointer;font-size:14px}
.actions .edit{background:#dbeafe}.actions .toggle{background:#fef3c7}.actions .toggle.on{background:#dcfce7}.actions .del{background:#fee2e2}
.empty{text-align:center;padding:60px 20px;color:#64748b}
.modal{position:fixed;top:0;left:0;right:0;bottom:0;background:rgba(0,0,0,.5);display:flex;align-items:center;justify-content:center;z-index:1000;padding:20px}
.modal-box{background:#fff;border-radius:16px;width:100%;max-width:500px;max-height:90vh;overflow-y:auto}
.modal-header{padding:20px;border-bottom:1px solid #e2e8f0;display:flex;justify-content:space-between;align-items:center}
.modal-header h3{font-size:18px;font-weight:600}.modal-close{width:32px;height:32px;border:none;background:#f1f5f9;border-radius:8px;cursor:pointer;font-size:18px}
.modal-body{padding:20px}.modal-footer{padding:16px 20px;border-top:1px solid #e2e8f0;display:flex;justify-content:flex-end;gap:12px}
.btn-cancel{background:#f1f5f9;color:#1e293b}.toast{position:fixed;bottom:20px;right:20px;padding:12px 20px;border-radius:8px;color:#fff;font-weight:500;z-index:2000}
.toast.ok{background:#22c55e}.toast.err{background:#ef4444}
@media(max-width:768px){.navbar{padding:0 12px}.main{padding:12px}th,td{padding:10px 12px;font-size:13px}}
</style>
</head>
<body>
<div id="app">
<div v-if="checking" class="loading"><div class="spinner"></div><p>加载中...</p></div>
<div v-else-if="needLogin&&!logged" class="login">
<div class="login-box">
<div class="icon">🔐</div>
<h1>订阅通知面板</h1>
<p>请输入管理员密码登录</p>
<form @submit.prevent="doLogin">
<div class="form-group"><label>密码</label><input v-model="pwd" type="password" required autofocus></div>
<button class="btn btn-primary" :disabled="logining">{{logining?'登录中...':'登录'}}</button>
<p v-if="loginErr" class="error">{{loginErr}}</p>
</form>
</div>
</div>
<div v-else>
<nav class="navbar">
<h1>🔔 订阅通知面板</h1>
<div class="navbar-actions">
<button class="btn" @click="openAdd">➕ 添加</button>
<button class="btn" @click="doNotify">📤 通知</button>
<button v-if="needLogin" class="btn" @click="doLogout">🚪 退出</button>
</div>
</nav>
<main class="main">
<div class="stats">
<div class="stat"><div class="stat-icon blue">📋</div><div><h3>{{subs.length}}</h3><p>总订阅</p></div></div>
<div class="stat"><div class="stat-icon green">✅</div><div><h3>{{active}}</h3><p>活跃</p></div></div>
<div class="stat"><div class="stat-icon orange">⏰</div><div><h3>{{due}}</h3><p>待通知</p></div></div>
</div>
<div class="card">
<div class="card-header"><h2>📋 订阅列表</h2><span style="color:#64748b;font-size:14px">共 {{subs.length}} 个</span></div>
<div v-if="loading" style="padding:40px;text-align:center"><p>加载中...</p></div>
<div v-else-if="subs.length===0" class="empty"><p>📭 暂无订阅</p></div>
<table v-else>
<thead><tr><th>名称</th><th>周期</th><th>下次通知</th><th>状态</th><th>操作</th></tr></thead>
<tbody><tr v-for="s in subs" :key="s.id">
<td><strong>{{s.name}}</strong><br><small style="color:#64748b">{{s.content||''}}</small></td>
<td><span class="badge badge-purple">{{cycleLabel(s)}}</span></td>
<td>{{s.next_notify_date}}</td>
<td><span :class="s.is_active?'badge badge-green':'badge badge-red'">{{s.is_active?'活跃':'停用'}}</span></td>
<td class="actions"><button class="edit" @click="openEdit(s)">✏️</button><button :class="s.is_active?'toggle':'toggle on'" @click="toggle(s)">{{s.is_active?'⏸':'▶'}}</button><button class="del" @click="del(s.id)">🗑</button></td>
</tr></tbody>
</table>
</div>
</main>
</div>
<div v-if="modal" class="modal" @click.self="modal=false">
<div class="modal-box">
<div class="modal-header"><h3>{{editId?'编辑':'添加'}}订阅</h3><button class="modal-close" @click="modal=false">✕</button></div>
<form @submit.prevent="save">
<div class="modal-body">
<div class="form-group"><label>名称 *</label><input v-model="form.name" required placeholder="例如：服务器续费"></div>
<div class="form-group"><label>内容</label><input v-model="form.content" placeholder="可选"></div>
<div class="form-group"><label>周期 *</label><select v-model="form.cycle_type" required><option value="">请选择</option><option value="daily">每日</option><option value="weekly">每周</option><option value="monthly">每月</option><option value="yearly">每年</option><option value="specific">指定日期</option></select></div>
<div v-if="form.cycle_type==='weekly'" class="form-group"><label>星期</label><select v-model="form.cycle_value"><option value="1">周一</option><option value="2">周二</option><option value="3">周三</option><option value="4">周四</option><option value="5">周五</option><option value="6">周六</option><option value="7">周日</option></select></div>
<div v-if="form.cycle_type==='monthly'" class="form-group"><label>几号(1-31)</label><input v-model="form.cycle_value" type="number" min="1" max="31"></div>
<div v-if="form.cycle_type==='yearly'" class="form-group"><label>月-日</label><input v-model="form.cycle_value" placeholder="12-25"></div>
<div v-if="form.cycle_type==='specific'" class="form-group"><label>日期</label><input v-model="form.cycle_value" type="date"></div>
</div>
<div class="modal-footer"><button type="button" class="btn btn-cancel" @click="modal=false">取消</button><button type="submit" class="btn btn-primary" style="width:auto">保存</button></div>
</form>
</div>
</div>
<div v-if="toast.show" :class="'toast '+toast.type">{{toast.msg}}</div>
</div>
<script src="https://cdn.jsdelivr.net/npm/vue@3/dist/vue.global.prod.js"></script>
<script>
const{createApp,ref,computed,onMounted}=Vue;
createApp({
setup(){
const checking=ref(true),needLogin=ref(false),logged=ref(false),pwd=ref(''),logining=ref(false),loginErr=ref('');
const subs=ref([]),loading=ref(false),modal=ref(false),editId=ref(null);
const form=ref({name:'',content:'',cycle_type:'',cycle_value:''});
const toast=ref({show:false,msg:'',type:'ok'});
const active=computed(()=>subs.value.filter(s=>s.is_active).length);
const due=computed(()=>{const t=new Date().toISOString().split('T')[0];return subs.value.filter(s=>s.is_active&&s.next_notify_date<=t).length});
const show=(msg,type='ok')=>{toast.value={show:true,msg,type};setTimeout(()=>toast.value.show=false,3000)};
const api=async(url,opt={})=>{const token=localStorage.getItem('token');const h={'Content-Type':'application/json',...opt.headers};if(token)h['Authorization']='Bearer '+token;const r=await fetch(url,{...opt,headers:h});if(r.status===401){logged.value=false;throw new Error('401');}return r;};
const check=async()=>{try{const r=await fetch('/api/auth/status');if(r.ok){const d=await r.json();needLogin.value=d.requireAuth;if(needLogin.value){const t=localStorage.getItem('token');if(t){const v=await(await fetch('/api/auth/verify',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({token:t})})).json();logged.value=v.valid;if(!v.valid)localStorage.removeItem('token');}else logged.value=false;}else logged.value=true;}if(logged.value)fetchSubs();}catch(e){logged.value=true;fetchSubs();}finally{checking.value=false;}};
const doLogin=async()=>{logining.value=true;loginErr.value='';try{const r=await fetch('/api/login',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({password:pwd.value})});const d=await r.json();if(d.success){localStorage.setItem('token',d.token);logged.value=true;show('登录成功');fetchSubs();}else loginErr.value=d.error||'密码错误';}catch(e){loginErr.value='登录失败';}finally{logining.value=false;}};
const doLogout=()=>{localStorage.removeItem('token');logged.value=false;subs.value=[];};
const fetchSubs=async()=>{try{loading.value=true;const r=await api('/api/subscriptions');if(r.ok)subs.value=await r.json();}catch(e){if(e.message!=='401')show('获取失败','err');}finally{loading.value=false;}};
const openAdd=()=>{editId.value=null;form.value={name:'',content:'',cycle_type:'',cycle_value:''};modal.value=true;};
const openEdit=s=>{editId.value=s.id;form.value={name:s.name,content:s.content,cycle_type:s.cycle_type,cycle_value:s.cycle_value};modal.value=true;};
const save=async()=>{try{const url=editId.value?'/api/subscriptions/'+editId.value:'/api/subscriptions';const r=await api(url,{method:editId.value?'PUT':'POST',body:JSON.stringify(form.value)});if(r.ok){show(editId.value?'更新成功':'添加成功');modal.value=false;fetchSubs();}}catch(e){if(e.message!=='401')show('操作失败','err');}};
const del=async id=>{if(!confirm('确定删除？'))return;try{const r=await api('/api/subscriptions/'+id,{method:'DELETE'});if(r.ok){show('删除成功');fetchSubs();}}catch(e){if(e.message!=='401')show('删除失败','err');}};
const toggle=async s=>{try{const r=await api('/api/subscriptions/'+s.id,{method:'PUT',body:JSON.stringify({is_active:!s.is_active})});if(r.ok){show(s.is_active?'已停用':'已启用');fetchSubs();}}catch(e){if(e.message!=='401')show('操作失败','err');}};
const doNotify=async()=>{try{const r=await api('/api/notify',{method:'POST'});if(r.ok){const d=await r.json();show('已发送'+d.sent+'条通知');fetchSubs();}}catch(e){if(e.message!=='401')show('通知失败','err');}};
const cycleLabel=s=>({daily:'每日',weekly:'每周'+['','一','二','三','四','五','六','日'][parseInt(s.cycle_value)||1],monthly:'每月'+(s.cycle_value||1)+'日',yearly:'每年'+(s.cycle_value||'1-1'),specific:s.cycle_value}[s.cycle_type]||s.cycle_type);
onMounted(check);
return{checking,needLogin,logged,pwd,logining,loginErr,subs,loading,modal,editId,form,toast,active,due,doLogin,doLogout,openAdd,openEdit,save,del,toggle,doNotify,cycleLabel};
}
}).mount('#app');
</script>
</body>
</html>`;
}