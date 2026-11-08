import crypto from 'crypto';
import { kv } from '@vercel/kv';

const BOT_TOKEN = process.env.BOT_TOKEN;
const DAY_MS = 24 * 60 * 60 * 1000;

// Проверка криптографической подписи Telegram WebApp
function verifyTelegramInitData(initData) {
  if (!initData || !BOT_TOKEN) return null;

  const params = new URLSearchParams(initData);
  const hash = params.get('hash');
  if (!hash) return null;

  params.delete('hash');

  // Защита от устаревших слепков (действителен 24 часа)
  const authDate = parseInt(params.get('auth_date') || '0', 10);
  const nowSec = Math.floor(Date.now() / 1000);
  if (nowSec - authDate > 86400) return null;

  const dataCheckString = Array.from(params.entries())
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([k, v]) => `${k}=${v}`)
    .join('\n');

  const secretKey = crypto
    .createHmac('sha256', 'WebAppData')
    .update(BOT_TOKEN)
    .digest();

  const calculatedHash = crypto
    .createHmac('sha256', secretKey)
    .update(dataCheckString)
    .digest('hex');

  if (calculatedHash !== hash) return null;

  try {
    return JSON.parse(params.get('user'));
  } catch {
    return null;
  }
}

// Инициализация пользователя со стартовым балансом 100 ₽
async function getOrCreateUser(tgId) {
  const key = `user:${tgId}`;
  // hsetnx гарантирует, что стартовые 100р начислятся строго 1 раз
  await kv.hsetnx(key, 'balance', 100);
  await kv.hsetnx(key, 'last_daily_bonus', 0);

  const user = await kv.hgetall(key);
  return {
    balance: Number(user?.balance ?? 100),
    last_daily_bonus: Number(user?.last_daily_bonus ?? 0)
  };
}

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method Not Allowed' });
  }

  const { action } = req.query;
  const { initData, amount, betType } = req.body || {};

  const tgUser = verifyTelegramInitData(initData);
  if (!tgUser || !tgUser.id) {
    return res.status(401).json({ error: 'Неверная подпись Telegram. Откройте игру через бота.' });
  }

  const userId = tgUser.id;
  const userKey = `user:${userId}`;

  try {
    // 1. АВТОРИЗАЦИЯ (/api/auth)
    if (action === 'auth') {
      const user = await getOrCreateUser(userId);
      return res.status(200).json({ balance: user.balance });
    }

    // 2. ЕЖЕДНЕВНЫЙ БОНУС 25 ₽ (/api/bonus)
    if (action === 'bonus') {
      await getOrCreateUser(userId);
      const now = Date.now();

      // Атомарный Lua-скрипт проверки таймера 24ч и начисления 25р
      const bonusLua = `
        local last = tonumber(redis.call('HGET', KEYS[1], 'last_daily_bonus') or '0')
        local now = tonumber(ARGV[1])
        local cooldown = tonumber(ARGV[2])
        if (now - last) < cooldown then
          return {0, cooldown - (now - last)}
        end
        redis.call('HSET', KEYS[1], 'last_daily_bonus', now)
        local newBal = redis.call('HINCRBY', KEYS[1], 'balance', 25)
        return {1, newBal}
      `;

      const [status, resultVal] = await kv.eval(bonusLua, [userKey], [now, DAY_MS]);

      if (status === 0) {
        const hoursLeft = Math.ceil(resultVal / (1000 * 60 * 60));
        return res.status(400).json({ error: `Бонус уже получен. Ждите ещё ~${hoursLeft} ч.` });
      }

      return res.status(200).json({ balance: resultVal });
    }

    // 3. БРОСОК КУБИКА (/api/roll)
    if (action === 'roll') {
      const betAmount = Number(amount);
      if (!Number.isInteger(betAmount) || betAmount < 1) {
        return res.status(400).json({ error: 'Ставка должна быть целым положительным числом' });
      }

      const validTypes = ['even', 'odd', 'low', 'high'];
      if (!validTypes.includes(betType)) {
        return res.status(400).json({ error: 'Некорректный выбор исхода' });
      }

      await getOrCreateUser(userId);

      // Криптографически безопасный бросок кубика (1 - 6)
      const dice = crypto.randomInt(1, 7);

      let won = false;
      if (betType === 'even' && dice % 2 === 0) won = true;
      if (betType === 'odd' && dice % 2 !== 0) won = true;
      if (betType === 'low' && dice >= 1 && dice <= 3) won = true;
      if (betType === 'high' && dice >= 4 && dice <= 6) won = true;

      // При победе чистая прибыль +betAmount (возврат ставки 2x), при проигрыше -betAmount
      const delta = won ? betAmount : -betAmount;

      // Атомарная проверка баланса и изменение счета (Защита от дюпа / Race Condition)
      const rollLua = `
        local bal = tonumber(redis.call('HGET', KEYS[1], 'balance') or '0')
        local bet = tonumber(ARGV[1])
        local delta = tonumber(ARGV[2])
        if bal < bet then
          return {0, bal}
        end
        local newBal = redis.call('HINCRBY', KEYS[1], 'balance', delta)
        return {1, newBal}
      `;

      const [ok, updatedBalance] = await kv.eval(rollLua, [userKey], [betAmount, delta]);

      if (ok === 0) {
        return res.status(400).json({ error: 'Недостаточно средств на балансе' });
      }

      return res.status(200).json({
        dice,
        won,
        payout: won ? betAmount * 2 : 0,
        balance: updatedBalance
      });
    }

    return res.status(400).json({ error: 'Unknown action' });
  } catch (err) {
    console.error('Game API Error:', err);
    return res.status(500).json({ error: 'Внутренняя ошибка сервера' });
  }
}