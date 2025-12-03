// worker.js
export default {
  async fetch(request, env) {
    // Telegram will POST updates (webhook) -> we handle only POST
    if (request.method === "POST") {
      try {
        const update = await request.json();
        if (!update.message) return new Response("ok", { status: 200 });

        const chatId = update.message.chat.id;
        const text = (update.message.text || "").trim();

        if (!text) return new Response("ok", { status: 200 });

        if (text.startsWith("/start") || text.startsWith("/help")) {
          return sendMessage(env, chatId,
            "سلام!\nدستورها:\n" +
            "/set SYMBOL PRICE — مثال: /set BTC 100000\n" +
            "/list — نمایش هشدارهای تو\n" +
            "/remove ID — حذف هشدار"
          );
        }

        if (text.startsWith("/set")) {
          const parts = text.split(/\s+/);
          if (parts.length < 3) return sendMessage(env, chatId, "فرمت درست: /set BTC 100000");

          const symbol = parts[1].toUpperCase();
          const target = parseFloat(parts[2].replace(/,/g,""));
          if (isNaN(target)) return sendMessage(env, chatId, "قیمت نامعتبر است.");

          const id = crypto.randomUUID();
          const record = { id, chatId, symbol, target, createdAt: Date.now() };
          await env.ALERTS.put(id, JSON.stringify(record));
          return sendMessage(env, chatId, `هشدار ثبت شد:\n${symbol} → ${target} USD\nid: ${id}`);
        }

        if (text.startsWith("/list")) {
          const out = await listAlerts(env, chatId);
          return sendMessage(env, chatId, out || "هیچ هشداری ثبت نشده.");
        }

        if (text.startsWith("/remove")) {
          const parts = text.split(/\s+/);
          if (parts.length < 2) return sendMessage(env, chatId, "فرمت: /remove ID");
          const id = parts[1];
          const existing = await env.ALERTS.get(id);
          if (!existing) return sendMessage(env, chatId, "هشداری با این ID پیدا نشد.");
          const obj = JSON.parse(existing);
          if (obj.chatId !== chatId) return sendMessage(env, chatId, "این هشدار متعلق به شما نیست.");
          await env.ALERTS.delete(id);
          return sendMessage(env, chatId, `هشدار ${id} حذف شد.`);
        }

        // هر پیام ورودی => بعد از پردازش دستور، قیمت‌ها را یکبار چک می‌کنیم
        // (اگر می‌خواهی جدا باشد، این فراخوانی را حذف کن و از Cron یا Worker Alarm استفاده کن)
        await checkPrices(env);
        return new Response("ok", { status: 200 });

      } catch (e) {
        return new Response("error: " + e.toString(), { status: 500 });
      }
    }

    // GET -> status page
    return new Response("Telegram price alert worker — up", { status: 200 });
  }
};

// send message to Telegram
async function sendMessage(env, chatId, text) {
  const url = `https://api.telegram.org/bot${env.BOT_TOKEN}/sendMessage`;
  await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ chat_id: chatId, text, parse_mode: "HTML" })
  });
  return new Response("sent", { status: 200 });
}

async function listAlerts(env, chatId) {
  let cursor = undefined;
  let lines = [];
  do {
    const listRes = await env.ALERTS.list({ cursor, limit: 100 });
    for (const k of listRes.keys) {
      const v = await env.ALERTS.get(k.name);
      if (!v) continue;
      const obj = JSON.parse(v);
      if (obj.chatId === chatId) {
        lines.push(`${obj.id} → ${obj.symbol} @ ${obj.target}`);
      }
    }
    cursor = listRes.cursor;
  } while (cursor);
  return lines.join("\n");
}

async function checkPrices(env) {
  // گروه‌بندی هشدارها بر اساس سمبل برای کاهش درخواست‌ها
  let cursor = undefined;
  const bySymbol = {};
  do {
    const listRes = await env.ALERTS.list({ cursor, limit: 100 });
    for (const k of listRes.keys) {
      const v = await env.ALERTS.get(k.name);
      if (!v) continue;
      const obj = JSON.parse(v);
      bySymbol[obj.symbol] = bySymbol[obj.symbol] || [];
      bySymbol[obj.symbol].push({ key: k.name, data: obj });
    }
    cursor = listRes.cursor;
  } while (cursor);

  for (const symbol of Object.keys(bySymbol)) {
    const price = await getPrice(env, symbol);
    if (price == null) continue;
    for (const item of bySymbol[symbol]) {
      const a = item.data;
      if (price >= a.target) {
        await sendMessage(env, a.chatId,
          `⚠️ هشدار قیمت!\n${a.symbol} به هدف رسید.\nقیمت فعلی: ${price}\nهدف: ${a.target}`
        );
        await env.ALERTS.delete(item.key);
      }
    }
  }
}

async function getPrice(env, symbol) {
  const coinId = symbol.toLowerCase(); // برای سادگی؛ اگر لازم شد نگاشت بزن
  const url = `${env.COINGECKO_URL}?ids=${encodeURIComponent(coinId)}&vs_currencies=usd`;
  try {
    const res = await fetch(url);
    if (!res.ok) return null;
    const data = await res.json();
    if (!data || !data[coinId] || typeof data[coinId].usd !== "number") return null;
    return data[coinId].usd;
  } catch (e) {
    return null;
  }
}

