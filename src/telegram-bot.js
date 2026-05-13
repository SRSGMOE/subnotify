// Telegram Bot Webhook处理程序
// 用于接收和处理Telegram Bot命令

export async function handleTelegramWebhook(request, env) {
    const botToken = env.TELEGRAM_BOT_TOKEN;
    
    if (request.method !== 'POST') {
        return new Response('Method not allowed', { status: 405 });
    }

    try {
        const update = await request.json();
        
        // 处理消息
        if (update.message) {
            await handleMessage(update.message, env);
        }
        
        // 处理回调查询（按钮点击）
        if (update.callback_query) {
            await handleCallbackQuery(update.callback_query, env);
        }

        return new Response('OK', { status: 200 });
    } catch (error) {
        console.error('处理webhook错误:', error);
        return new Response('Error', { status: 500 });
    }
}

async function handleMessage(message, env) {
    const chatId = message.chat.id;
    const text = message.text;
    const db = env.DB;

    if (!text) return;

    const command = text.split(' ')[0].toLowerCase();
    const args = text.split(' ').slice(1).join(' ');

    switch (command) {
        case '/start':
            await sendMessage(env, chatId, 
                `👋 *欢迎使用订阅通知机器人!*\n\n` +
                `可用命令:\n` +
                `/list - 查看所有订阅\n` +
                `/add - 添加新订阅\n` +
                `/today - 查看今日待通知\n` +
                `/notify - 立即检查并发送通知\n` +
                `/help - 显示帮助信息`
            );
            break;

        case '/help':
            await sendMessage(env, chatId,
                `📚 *命令说明*\n\n` +
                `/list - 显示所有订阅列表\n` +
                `/add 名称|内容|周期|值 - 添加订阅\n` +
                `  周期: daily/weekly/monthly/yearly/specific\n` +
                `  示例: /add 服务器续费|AWS服务器|monthly|15\n\n` +
                `/today - 显示今日需要通知的订阅\n` +
                `/notify - 手动触发通知检查\n` +
                `/status - 查看系统状态`
            );
            break;

        case '/list':
            const { results: subs } = await db.prepare(
                'SELECT * FROM subscriptions WHERE is_active = 1 ORDER BY next_notify_date'
            ).all();

            if (subs.length === 0) {
                await sendMessage(env, chatId, '📋 当前没有活跃的订阅');
                return;
            }

            let listMsg = '📋 *活跃订阅列表:*\n\n';
            subs.forEach((sub, index) => {
                listMsg += `${index + 1}. *${sub.name}*\n`;
                listMsg += `   📅 周期: ${getCycleLabel(sub.cycle_type, sub.cycle_value)}\n`;
                listMsg += `   ⏰ 下次通知: ${sub.next_notify_date}\n\n`;
            });

            await sendMessage(env, chatId, listMsg);
            break;

        case '/add':
            if (!args) {
                await sendMessage(env, chatId, 
                    '❌ 请提供订阅信息\n格式: /add 名称|内容|周期|值\n示例: /add 服务器续费|AWS服务器|monthly|15'
                );
                return;
            }

            const parts = args.split('|');
            if (parts.length < 3) {
                await sendMessage(env, chatId, '❌ 格式错误，至少需要: 名称|周期|值');
                return;
            }

            const [name, content, cycleType, cycleValue] = parts;
            const validCycles = ['daily', 'weekly', 'monthly', 'yearly', 'specific'];
            
            if (!validCycles.includes(cycleType)) {
                await sendMessage(env, chatId, '❌ 无效的周期类型，可选: daily/weekly/monthly/yearly/specific');
                return;
            }

            try {
                const nextDate = calculateNextNotifyDate(cycleType, cycleValue);
                
                await db.prepare(
                    `INSERT INTO subscriptions (name, content, cycle_type, cycle_value, next_notify_date) 
                     VALUES (?, ?, ?, ?, ?)`
                ).bind(name.trim(), content?.trim() || '', cycleType, cycleValue || '', nextDate).run();

                await sendMessage(env, chatId, 
                    `✅ *订阅添加成功!*\n\n` +
                    `📌 名称: ${name}\n` +
                    `📅 周期: ${getCycleLabel(cycleType, cycleValue)}\n` +
                    `⏰ 下次通知: ${nextDate}`
                );
            } catch (error) {
                await sendMessage(env, chatId, `❌ 添加失败: ${error.message}`);
            }
            break;

        case '/today':
            const today = new Date().toISOString().split('T')[0];
            const { results: dueSubs } = await db.prepare(
                'SELECT * FROM subscriptions WHERE next_notify_date <= ? AND is_active = 1'
            ).bind(today).all();

            if (dueSubs.length === 0) {
                await sendMessage(env, chatId, '✅ 今日没有待通知的订阅');
                return;
            }

            let todayMsg = '🔔 *今日待通知:*\n\n';
            dueSubs.forEach((sub, index) => {
                todayMsg += `${index + 1}. *${sub.name}*\n`;
                if (sub.content) todayMsg += `   📝 ${sub.content}\n`;
                todayMsg += `   📅 ${getCycleLabel(sub.cycle_type, sub.cycle_value)}\n\n`;
            });

            await sendMessage(env, chatId, todayMsg);
            break;

        case '/notify':
            await sendMessage(env, chatId, '⏳ 正在检查并发送通知...');
            
            const result = await checkAndSendNotifications(db, env);
            
            await sendMessage(env, chatId, 
                `✅ *通知检查完成*\n\n` +
                `📊 检查数量: ${result.checked}\n` +
                `📨 发送成功: ${result.sent}\n` +
                `❌ 发送失败: ${result.checked - result.sent}`
            );
            break;

        case '/status':
            const { results: allSubs } = await db.prepare('SELECT COUNT(*) as count FROM subscriptions').all();
            const { results: activeSubs } = await db.prepare('SELECT COUNT(*) as count FROM subscriptions WHERE is_active = 1').all();
            const { results: todayNotifs } = await db.prepare(
                "SELECT COUNT(*) as count FROM notifications WHERE date(sent_at) = date('now')"
            ).all();

            await sendMessage(env, chatId,
                `📊 *系统状态*\n\n` +
                `📋 总订阅数: ${allSubs[0].count}\n` +
                `✅ 活跃订阅: ${activeSubs[0].count}\n` +
                `📨 今日已通知: ${todayNotifs[0].count}\n` +
                `⏰ 当前时间: ${new Date().toLocaleString('zh-CN')}`
            );
            break;

        default:
            await sendMessage(env, chatId, '❓ 未知命令，输入 /help 查看帮助');
    }
}

async function handleCallbackQuery(callbackQuery, env) {
    const chatId = callbackQuery.message.chat.id;
    const data = callbackQuery.data;

    // 处理按钮回调
    if (data.startsWith('toggle_')) {
        const id = data.split('_')[1];
        const db = env.DB;
        
        const { results } = await db.prepare('SELECT * FROM subscriptions WHERE id = ?').bind(id).all();
        
        if (results.length > 0) {
            const sub = results[0];
            await db.prepare('UPDATE subscriptions SET is_active = ? WHERE id = ?')
                .bind(sub.is_active ? 0 : 1, id).run();
            
            await sendMessage(env, chatId, 
                `✅ 已${sub.is_active ? '停用' : '启用'}: ${sub.name}`
            );
        }
    }

    // 回答回调查询
    await fetch(`https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/answerCallbackQuery`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ callback_query_id: callbackQuery.id })
    });
}

async function sendMessage(env, chatId, text) {
    const url = `https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/sendMessage`;
    
    await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
            chat_id: chatId,
            text: text,
            parse_mode: 'Markdown'
        })
    });
}

function getCycleLabel(cycleType, cycleValue) {
    const labels = {
        'daily': '每日',
        'weekly': `每周${['', '一', '二', '三', '四', '五', '六', '日'][parseInt(cycleValue) || 1]}`,
        'monthly': `每月${cycleValue || 1}日`,
        'yearly': `每年${cycleValue || '1-1'}`,
        'specific': `指定日期: ${cycleValue}`
    };
    return labels[cycleType] || cycleType;
}

function calculateNextNotifyDate(cycleType, cycleValue) {
    const now = new Date();
    let nextDate = new Date();

    switch (cycleType) {
        case 'daily':
            nextDate.setDate(now.getDate() + 1);
            break;
        case 'weekly':
            const targetDay = parseInt(cycleValue) || 1;
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
            nextDate = new Date(cycleValue);
            if (nextDate <= now) {
                nextDate.setFullYear(nextDate.getFullYear() + 1);
            }
            break;
    }

    return nextDate.toISOString().split('T')[0];
}

async function checkAndSendNotifications(db, env) {
    const today = new Date().toISOString().split('T')[0];
    
    const { results: dueSubscriptions } = await db.prepare(
        `SELECT * FROM subscriptions WHERE next_notify_date <= ? AND is_active = 1`
    ).bind(today).all();

    const sentNotifications = [];

    for (const sub of dueSubscriptions) {
        try {
            const message = `🔔 *订阅到期提醒*\n\n` +
                `📌 *名称*: ${sub.name}\n` +
                `📝 *内容*: ${sub.content || '无'}\n` +
                `📅 *周期*: ${getCycleLabel(sub.cycle_type, sub.cycle_value)}\n` +
                `⏰ *下次通知*: ${sub.next_notify_date}`;

            await sendMessage(env, env.TELEGRAM_CHAT_ID, message);
            
            await db.prepare(
                'INSERT INTO notifications (subscription_id, status) VALUES (?, ?)'
            ).bind(sub.id, 'success').run();

            const nextDate = calculateNextNotifyDate(sub.cycle_type, sub.cycle_value);
            await db.prepare(
                'UPDATE subscriptions SET next_notify_date = ? WHERE id = ?'
            ).bind(nextDate, sub.id).run();

            sentNotifications.push({ id: sub.id, name: sub.name, status: 'success' });
        } catch (error) {
            await db.prepare(
                'INSERT INTO notifications (subscription_id, status) VALUES (?, ?)'
            ).bind(sub.id, 'failed: ' + error.message).run();

            sentNotifications.push({ id: sub.id, name: sub.name, status: 'failed' });
        }
    }

    return {
        checked: dueSubscriptions.length,
        sent: sentNotifications.filter(n => n.status === 'success').length
    };
}