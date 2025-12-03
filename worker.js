export default {
  async fetch(request, env) {
    if (request.method === "POST") {
      // دریافت آپدیت از تلگرام
      try {
        const update = await request.json();
        if (update.message && update.message.text) {
          return handleTelegramMessage(update.message, env);
        }
      } catch (e) {
        return new Response("bad request", { status: 400 });
      }
      return new Response("ok", { status: 200 });
    }

    // GET برای بررسی وضعیت Worker
    return new Response("Telegram price alert worker is running.", { status: 200 });
  },

  // تابع کرون برای بررسی قیمت‌ها
  async scheduled(event, env, ctx) {
    await checkAllAlerts(env);
  }
};

// --------- توابع کمکی ---------

async function handleTelegramMessage(message, env) {
  const chatId = message.chat.id;
  const text = (message.text || "").trim();

  if (text.startsWith("/start") || text.startsWith("/help")) {
    await sendTelegram(env, chatId,
      "سلام!\nدستورها:\n" +
      "/set SYMBOL PRICE — مثال: /set BTC 100000\n" +
      "/list — نمایش هشدارهای فعال\n" +
      "/remove ID — حذف هشدار"
    );
    return new Response("ok", { status: 200 });
  }

  if (text.startsWith("/set")) {
    const parts = text.split(/\s+/);
    if (parts.length < 3) {
      await sendTelegram(env, chatId, "فرمت درست: /set BTC 100000");
      return new Response("ok", { status: 200 });
    }
    const symbol = parts[1].toUpperCase();
    const target = Number(parts[2].replace(/,/g, ""));
    if (isNaN(target)) {
      await sendTelegram(env, chatId, "قیمت نامعتبر است.");
      return new Response("ok", { status: 200 });
    }
    const id = crypto.randomUUID();
    const record = { id, chatId, symbol, target, createdAt: Date.now() };
    await env.ALERTS.put(id, JSON.stringify(record));
    await sendTelegram(env, chatId, `✅ هشدار ثبت شد: ${symbol} @ ${target} USD\nid: ${id}`);
    return new Response("ok", { status: 200 });
  }

  if (text.startsWith("/list")) {
    const lines = await listUserAlerts(env, chatId);
    await sendTelegram(env, chatId, lines || "هیچ هشداری ثبت نشده.");
    return new Response("ok", { status: 200 });
  }

  if (text.startsWith("/remove")) {
    const parts = text.split(/\s+/);
    if (parts.length < 2) {
      await sendTelegram(env, chatId, "فرمت: /remove ID");
      return new Response("ok", { status: 200 });
    }
    const id = parts[1];
    const v = await env.ALERTS.get(id);
    if (!v) {
      await sendTelegram(env, chatId, "هشداری با این ID پیدا نشد.");
      return new Response("ok", { status: 200 });
    }
    const obj = JSON.parse(v);
    if (obj.chatId !== chatId) {
      await sendTelegram(env, chatId, "این هشدار متعلق به شما نیست.");
      return new Response("ok", { status: 200 });
    }
    await env.ALERTS.delete(id);
    await sendTelegram(env, chatId, `✅ هشدار ${id} حذف شد.`);
    return new Response("ok", { status: 200 });
  }

  // دستور ناشناخته
  await sendTelegram(env, chatId, "دستور ناشناخته. /help را بزنید.");
  return new Response("ok", { status: 200 });
}

// --------- توابع اصلی ---------

async function sendTelegram(env, chatId, text) {
  const url = `https://api.telegram.org/bot${env.TELEGRAM_TOKEN}/sendMessage`;
  await fetch(url, {
    method: "POST",
    headers: {"content-type":"application/json"},
    body: JSON.stringify({ chat_id: chatId, text })
  });
}

async function listUserAlerts(env, chatId) {
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
  return out.join("\n");
}

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
