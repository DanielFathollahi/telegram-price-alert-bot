export default {
  async fetch(request, env) {
    if (request.method === "POST") {
      try {
        const update = await request.json();
        // پیام از کاربر
        if (update.message && update.message.text) {
          return handleTelegramMessage(update.message, env);
        }
        // پیام از گروه مدیر
        if (update.message && update.message.chat && update.message.chat.id === Number(env.ADMIN_GROUP_ID)) {
          return handleAdminReply(update.message, env);
        }
      } catch (e) {
        return new Response("bad request", { status: 400 });
      }
      return new Response("ok", { status: 200 });
    }

    return new Response("Telegram price alert worker is running.", { status: 200 });
  },

  async scheduled(event, env, ctx) {
    await checkAllAlerts(env);
  }
};

// --------- متغیرهای مهم ---------
const ADMIN_CHAT_ID = Number("-1003378655692"); // گروه مدیر
const MAIN_ADMIN_ID = Number("6441736006"); // تو
// -----------------------------------

// --------- توابع ---------
async function handleTelegramMessage(msg, env) {
  const chatId = msg.chat.id;
  const text = (msg.text || "").trim();

  // بررسی ثبت نام
  const userConfirmed = await env.USERS.get(String(chatId));
  const pendingUser = await env.PENDING_USERS.get(String(chatId));

  if (text.startsWith("/start")) {
    if (userConfirmed) {
      await sendTelegram(env, chatId, "شما قبلاً ثبت‌نام شده‌اید و می‌توانید از ربات استفاده کنید.");
      return new Response("ok");
    }
    await sendTelegram(env, chatId,
      "سلام! لطفاً اطلاعات خود را به این فرمت بفرستید:\nنام, فامیل, شماره تماس"
    );
    return new Response("ok");
  }

  // اگر کاربر در لیست تأیید شده است → دستورات اصلی
  if (userConfirmed) {
    if (text.startsWith("/set")) return handleSetAlert(chatId, text, env);
    if (text.startsWith("/list")) return handleListAlerts(chatId, env);
    if (text.startsWith("/remove")) return handleRemoveAlert(chatId, text, env);
    if (text.startsWith("/price")) return handlePrice(chatId, text, env);
    return sendTelegram(env, chatId, "دستور ناشناخته. /help را بزنید.");
  }

  // اگر کاربر در Pending
  if (pendingUser) {
    await sendTelegram(env, chatId, "اطلاعات شما قبلاً ارسال شده و در انتظار تأیید مدیر است.");
    return new Response("ok");
  }

  // ذخیره اطلاعات کاربر جدید در Pending
  if (!userConfirmed && !pendingUser) {
    const parts = text.split(",");
    if (parts.length < 3) {
      await sendTelegram(env, chatId, "فرمت اشتباه است. لطفاً به این صورت ارسال کنید:\nنام, فامیل, شماره تماس");
      return new Response("ok");
    }
    const record = {
      name: parts[0].trim(),
      surname: parts[1].trim(),
      phone: parts[2].trim(),
      chatId
    };
    await env.PENDING_USERS.put(String(chatId), JSON.stringify(record));

    // پیام به گروه مدیر
    const msgText = `New user registration request:\nName: ${record.name}\nSurname: ${record.surname}\nPhone: ${record.phone}\nChatId: ${chatId}\nReply 'accept' to approve, 'DONT USE' to reject.`;
    await sendTelegram(env, ADMIN_CHAT_ID, msgText);
    await sendTelegram(env, chatId, "اطلاعات شما ثبت شد و در انتظار تأیید مدیر است.");
    return new Response("ok");
  }

  return new Response("ok");
}

// --------- مدیریت پاسخ مدیر ---------
async function handleAdminReply(msg, env) {
  const text = (msg.text || "").trim().toLowerCase();

  // بررسی accept
  if (text === "accept") {
    // پیدا کردن آخرین Pending
    const list = await env.PENDING_USERS.list({ limit: 100 });
    if (!list.keys.length) return new Response("ok");
    const lastKey = list.keys[list.keys.length - 1].name;
    const data = await env.PENDING_USERS.get(lastKey);
    if (!data) return new Response("ok");
    await env.USERS.put(lastKey, data);
    await env.PENDING_USERS.delete(lastKey);

    const user = JSON.parse(data);
    await sendTelegram(env, user.chatId, "✅ شما تأیید شدید و می‌توانید از ربات استفاده کنید.");
  }

  if (text === "dont use") {
    const list = await env.PENDING_USERS.list({ limit: 100 });
    if (!list.keys.length) return new Response("ok");
    const lastKey = list.keys[list.keys.length - 1].name;
    const data = await env.PENDING_USERS.get(lastKey);
    if (!data) return new Response("ok");
    const user = JSON.parse(data);
    await env.PENDING_USERS.delete(lastKey);
    await sendTelegram(env, user.chatId, "❌ شما تأیید نشدید و نمی‌توانید از ربات استفاده کنید.");
  }

  return new Response("ok");
}

// --------- دستورات کاربران ---------

async function handleSetAlert(chatId, text, env) {
  const parts = text.split(/\s+/);
  if (parts.length < 3) return sendTelegram(env, chatId, "فرمت درست: /set SYMBOL PRICE");
  const symbol = parts[1].toUpperCase();
  const target = Number(parts[2].replace(/,/g, ""));
  if (isNaN(target)) return sendTelegram(env, chatId, "قیمت نامعتبر است.");
  const id = crypto.randomUUID();
  const record = { id, chatId, symbol, target, createdAt: Date.now() };
  await env.ALERTS.put(id, JSON.stringify(record));
  await sendTelegram(env, chatId, `✅ هشدار ثبت شد: ${symbol} @ ${target} USD\nid: ${id}`);
  return new Response("ok");
}

async function handleListAlerts(chatId, env) {
  let cursor = undefined;
  const out = [];
  do {
    const res = await env.ALERTS.list({ cursor, limit: 100 });
    for (const k of res.keys) {
      const v = await env.ALERTS.get(k.name);
      if (!v) continue;
      const obj = JSON.parse(v);
      if (obj.chatId === chatId) out.push(`${obj.id} → ${obj.symbol} @ ${obj.target}`);
    }
    cursor = res.cursor;
  } while (cursor);
  await sendTelegram(env, chatId, out.length ? out.join("\n") : "هیچ هشداری ثبت نشده.");
  return new Response("ok");
}

async function handleRemoveAlert(chatId, text, env) {
  const parts = text.split(/\s+/);
  if (parts.length < 2) return sendTelegram(env, chatId, "فرمت: /remove ID");
  const id = parts[1];
  const v = await env.ALERTS.get(id);
  if (!v) return sendTelegram(env, chatId, "هشداری با این ID پیدا نشد.");
  const obj = JSON.parse(v);
  if (obj.chatId !== chatId) return sendTelegram(env, chatId, "این هشدار متعلق به شما نیست.");
  await env.ALERTS.delete(id);
  await sendTelegram(env, chatId, `✅ هشدار ${id} حذف شد.`);
  return new Response("ok");
}

async function handlePrice(chatId, text, env) {
  const parts = text.split(/\s+/);
  if (parts.length < 2) return sendTelegram(env, chatId, "فرمت درست: /price SYMBOL");
  const symbol = parts[1].toUpperCase();
  const price = await fetchPrice(symbol);
  if (price == null) return sendTelegram(env, chatId, "قیمت پیدا نشد یا نماد معتبر نیست.");
  await sendTelegram(env, chatId, `💰 ${symbol}: ${price} USD`);
  return new Response("ok");
}

// --------- بررسی هشدارها ---------
async function checkAllAlerts(env) {
  let cursor = undefined;
  const bySym = {};
  do {
    const res = await env.ALERTS.list({ cursor, limit: 100 });
    for (const k of res.keys) {
      const v = await env.ALERTS.get(k.name);
      if (!v) continue;
      const obj = JSON.parse(v);
      bySym[obj.symbol] = bySym[obj.symbol] || [];
      bySym[obj.symbol].push({ key: k.name, data: obj });
    }
    cursor = res.cursor;
  } while (cursor);

  for (const symbol of Object.keys(bySym)) {
    const price = await fetchPrice(symbol);
    if (price == null) continue;
    for (const item of bySym[symbol]) {
      const a = item.data;
      if (price >= a.target) {
        await sendTelegram(env, a.chatId,
          `⚠️ قیمت رسید!\n${a.symbol}: ${price} USD\nهدف: ${a.target}\n(id: ${a.id})`
        );
        await env.ALERTS.delete(item.key);
      }
    }
  }
}

// --------- گرفتن قیمت ---------
async function fetchPrice(symbol) {
  try {
    const r = await fetch(`https://api.binance.com/api/v3/ticker/price?symbol=${symbol}USDT`);
    if (r.ok) {
      const j = await r.json();
      if (j && j.price) return Number(j.price);
    }
  } catch (e) {}
  try {
    const id = symbol.toLowerCase();
    const r2 = await fetch(`https://api.coingecko.com/api/v3/simple/price?ids=${id}&vs_currencies=usd`);
    if (r2.ok) {
      const j2 = await r2.json();
      if (j2 && j2[id] && typeof j2[id].usd === "number") return j2[id].usd;
    }
  } catch (e) {}
  return null;
}

// --------- ارسال پیام ---------
async function sendTelegram(env, chatId, text) {
  const url = `https://api.telegram.org/bot${env.TELEGRAM_TOKEN}/sendMessage`;
  await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ chat_id: chatId, text })
  });
}
