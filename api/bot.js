import { kv } from '@vercel/kv';

const BOT_TOKEN = process.env.BOT_TOKEN;
const DAY_MS = 24 * 60 * 60 * 1000;

async function tgApi(method, payload) {
  const url = `https://api.telegram.org/bot${BOT_TOKEN}/${method}`;
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload)
  });
  return res.json();
}

async function getOrCreateUser(tgId) {
  const key = `user:${tgId}`;
  await kv.hsetnx(key, 'balance', 100);
  await kv.hsetnx(key, 'last_daily_bonus', 0);
  const data = await kv.hgetall(key);
  return {
    balance: Number(data?.balance ?? 100),
    last_daily_bonus: Number(data?.last_daily_bonus ?? 0)
  };
}

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(200).send('Bot webhook is running');
  }

  const update = req.body;
  const host = req.headers['x-forwarded-host'] || req.headers.host;
  const webAppUrl = process.env.WEBAPP_URL || `https://${host}`;

  try {
    // 1. Обработка текстовых сообщений
    if (update.message) {
      const chatId = update.message.chat.id;
      const userId = update.message.from.id;
      const text = update.message.text || '';

      if (text.startsWith('/start')) {
        await getOrCreateUser(userId);

        await tgApi('sendMessage', {
          chat_id: chatId,
          text: 'Добро пожаловать в кубик',
          reply_markup: {
            keyboard: [
              [
                { text: 'Баланс' },
                { text: 'Играть', web_app: { url: webAppUrl } }
              ]
            ],
            resize_keyboard: true
          }
        });
      } else if (text === 'Баланс') {
        const user = await getOrCreateUser(userId);
        const now = Date.now();
        const canClaim = (now - user.last_daily_bonus) >= DAY_MS;

        const inlineKeyboard = [];
        if (canClaim) {
          inlineKeyboard.push([{ text: '🎁 Забрать бонус +25 ₽', callback_data: 'claim_daily' }]);
        }
        inlineKeyboard.push([{ text: '🎲 Открыть игру', web_app: { url: webAppUrl } }]);

        const bonusStatus = canClaim
          ? 'Доступен ежедневный бонус +25 ₽!'
          : `Следующий бонус через ~${Math.ceil((DAY_MS - (now - user.last_daily_bonus)) / 3600000)} ч.`;

        await tgApi('sendMessage', {
          chat_id: chatId,
          text: `💰 Ваш баланс: ${user.balance} ₽\n🎁 Бонус: ${bonusStatus}`,
          reply_markup: { inline_keyboard: inlineKeyboard }
        });
      }
    }

    // 2. Обработка нажатия на Inline-кнопку бонуса в боте
    if (update.callback_query) {
      const cb = update.callback_query;
      const userId = cb.from.id;
      const chatId = cb.message.chat.id;

      if (cb.data === 'claim_daily') {
        const userKey = `user:${userId}`;
        const now = Date.now();

        const bonusLua = `
          local last = tonumber(redis.call('HGET', KEYS[1], 'last_daily_bonus') or '0')
          local now = tonumber(ARGV[1])
          local cooldown = tonumber(ARGV[2])
          if (now - last) < cooldown then
            return {0, 0}
          end
          redis.call('HSET', KEYS[1], 'last_daily_bonus', now)
          local newBal = redis.call('HINCRBY', KEYS[1], 'balance', 25)
          return {1, newBal}
        `;

        const [ok, newBal] = await kv.eval(bonusLua, [userKey], [now, DAY_MS]);

        if (ok === 1) {
          await tgApi('answerCallbackQuery', {
            callback_query_id: cb.id,
            text: 'Вам начислено +25 ₽!',
            show_alert: true
          });
          await tgApi('sendMessage', {
            chat_id: chatId,
            text: `✅ Бонус получен! Ваш новый баланс: ${newBal} ₽`
          });
        } else {
          await tgApi('answerCallbackQuery', {
            callback_query_id: cb.id,
            text: 'Бонус уже был получен за последние 24 часа.',
            show_alert: true
          });
        }
      }
    }

    return res.status(200).json({ ok: true });
  } catch (err) {
    console.error('Bot Webhook Error:', err);
    return res.status(200).json({ ok: true });
  }
}