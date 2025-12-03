export default {
  async fetch(request, env) {
    if (request.method === "POST") {
      try {
        const update = await request.json();

        // پیام از کاربر
        if (update.message && update.message.text) {
          const chatId = update.message.chat.id;
          const text = (update.message.text || "").trim();
          const chatType = update.message.chat.type;

          // اگر پیام از گروه مدیر باشد
          if (chatId === Number(env.ADMIN_GROUP_ID) && chatType === "supergroup") {
            return handleAdminReply(update.message, env);
          }

          // پیام از کاربر
          return handleUserMessage(update.message, env);
        }
      } catch (e) {
        return new Response("bad request", { status: 400 });
      }
      return new Response("ok", { status: 200 });
    }

    return new Response("Telegram price alert worker is running.", { status: 200 });
  }
};

// --------- توابع مهم ---------

// ارسال پیام به تلگرام
async function sendTelegram(env, chatId, text) {
  const url = `https://api.telegram.org/bot${env.TELEGRAM_TOKEN}/sendMessage`;
  await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ chat_id: chatId, text })
  });
}

// مدیریت پیام کاربران
async function handleUserMessage(msg, env) {
  const chatId = msg.chat.id;
  const text = (msg.text || "").trim();

  // چک کاربر تأیید شده
  const confirmed = await env.USERS.get(String(chatId));
  const pendingStep = await env.REGISTRATION_STEP.get(String(chatId));

  if (text === "/start") {
    if (confirmed) {
      await sendTelegram(env, chatId, "شما قبلاً تأیید شده‌اید و می‌توانید از ربات استفاده کنید.");
      return new Response("ok");
    }
    // شروع ثبت‌نام
    await env.REGISTRATION_STEP.put(String(chatId), "1");
    await sendTelegram(env, chatId, "سلام! لطفاً نام خود را وارد کنید:");
    return new Response("ok");
  }

  // اگر کاربر تأیید شده → می‌تواند دستورات اصلی (بعداً اضافه می‌کنیم)
  if (confirmed) {
    await sendTelegram(env, chatId, "شما تأیید شده‌اید. می‌توانید هشدارها و قیمت‌ها را مدیریت کنید.");
    return new Response("ok");
  }

  // ثبت‌نام مرحله‌ای
  if (!pendingStep) {
    await sendTelegram(env, chatId, "لطفاً ابتدا /start را بزنید.");
    return new Response("ok");
  }

  // مرحله 1 → دریافت نام
  if (pendingStep === "1") {
    await env.REGISTRATION_NAME.put(String(chatId), text);
    await env.REGISTRATION_STEP.put(String(chatId), "2");
    await sendTelegram(env, chatId, "لطفاً نام خانوادگی خود را وارد کنید:");
    return new Response("ok");
  }

  // مرحله 2 → دریافت نام خانوادگی
  if (pendingStep === "2") {
    await env.REGISTRATION_SURNAME.put(String(chatId), text);
    await env.REGISTRATION_STEP.put(String(chatId), "3");
    await sendTelegram(env, chatId, "لطفاً شماره تماس خود را وارد کنید:");
    return new Response("ok");
  }

  // مرحله 3 → دریافت شماره تماس
  if (pendingStep === "3") {
    await env.REGISTRATION_PHONE.put(String(chatId), text);

    // جمع‌آوری اطلاعات کامل
    const name = await env.REGISTRATION_NAME.get(String(chatId));
    const surname = await env.REGISTRATION_SURNAME.get(String(chatId));
    const phone = text;

    // ذخیره موقت در Pending
    const record = { chatId, name, surname, phone };
    await env.PENDING_USERS.put(String(chatId), JSON.stringify(record));

    // پاک کردن مراحل ثبت‌نام
    await env.REGISTRATION_STEP.delete(String(chatId));
    await env.REGISTRATION_NAME.delete(String(chatId));
    await env.REGISTRATION_SURNAME.delete(String(chatId));
    await env.REGISTRATION_PHONE.delete(String(chatId));

    // پیام به گروه مدیر
    const msgText = `New user registration request:\nName: ${name}\nSurname: ${surname}\nPhone: ${phone}\nChatId: ${chatId}\nReply 'accept' to approve, 'DONT USE' to reject.`;
    await sendTelegram(env, Number(env.ADMIN_GROUP_ID), msgText);
    await sendTelegram(env, chatId, "✅ اطلاعات شما ثبت شد و در انتظار تأیید مدیر است.");
    return new Response("ok");
  }

  return new Response("ok");
}

// مدیریت reply مدیر
async function handleAdminReply(msg, env) {
  const text = (msg.text || "").trim().toLowerCase();

  // accept
  if (text === "accept") {
    const list = await env.PENDING_USERS.list({ limit: 100 });
    if (!list.keys.length) return new Response("ok");
    const lastKey = list.keys[list.keys.length - 1].name;
    const data = await env.PENDING_USERS.get(lastKey);
    if (!data) return new Response("ok");
    const user = JSON.parse(data);
    await env.USERS.put(lastKey, JSON.stringify(user));
    await env.PENDING_USERS.delete(lastKey);
    await sendTelegram(env, user.chatId, "✅ شما تأیید شدید و می‌توانید از ربات استفاده کنید.");
  }

  // DONT USE
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
