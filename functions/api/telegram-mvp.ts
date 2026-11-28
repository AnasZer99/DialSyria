import { Env, Handler, json } from "./_lib";
import { codeHash, linkMvpChat, mvpOnDemandNews, mvpSend } from "./_rss_mvp";

/**
 * Dedicated Telegram webhook for the RSS MVP subscriber journey.
 * Fully separate from the legacy Beta webhook (/api/telegram): its own bot
 * token, its own webhook secret, its own pairing codes and commands.
 *
 * Commands: /start <code> (pairing), /status, /news, /stop, /help.
 * No command ever self-activates a subscription — delivery requires the
 * admin-approved `active` status.
 */

interface TgUpdate {
  message?: {
    text?: string;
    chat?: { id: number; type?: string };
    from?: { id?: number };
  };
}

export const onRequestPost: Handler = async ({ request, env }) => {
  if (!env.DB || !env.TELEGRAM_MVP_BOT_TOKEN || !env.TELEGRAM_MVP_WEBHOOK_SECRET) return json({ ok: true });
  if ((request.headers.get("x-telegram-bot-api-secret-token") || "") !== env.TELEGRAM_MVP_WEBHOOK_SECRET) {
    return new Response("unauthorized", { status: 401 });
  }
  // The whole MVP journey is flag-gated: with RSS_MVP_MODE not "1" no command
  // executes and nothing is ever sent (the update is acknowledged silently).
  if (env.RSS_MVP_MODE !== "1") return json({ ok: true });
  let update: TgUpdate;
  try {
    update = (await request.json()) as TgUpdate;
  } catch {
    return json({ ok: true });
  }
  const msg = update.message;
  if (!msg?.chat?.id || !msg.from) return json({ ok: true });
  // Private chats only; the sender must be the chat itself (no groups/channels,
  // no spoofed senders, and webhook replays stay idempotent).
  if (msg.chat.type !== "private" || msg.from.id !== msg.chat.id) return json({ ok: true });
  const chatId = String(msg.chat.id);
  const text = (msg.text || "").trim();
  const send = (t: string) => mvpSend(env, chatId, t);

  if (text.startsWith("/stop")) {
    const row = await env.DB.prepare("SELECT id FROM subscribers WHERE telegram_chat_id = ?").bind(chatId).first<{ id: string }>();
    if (row) {
      await env.DB.prepare(
        "INSERT INTO rss_telegram_prefs (subscriber_id, paused, updated_at) VALUES (?,?,?) ON CONFLICT(subscriber_id) DO UPDATE SET paused=1, updated_at=excluded.updated_at"
      ).bind(row.id, 1, new Date().toISOString()).run();
      await send("تم إيقاف استقبال النشرة (/stop). لن تصلك نشرات حتى يعيد تفعيلها المدير.");
    } else {
      await send("حسابك غير مرتبط بعد.");
    }
    return json({ ok: true });
  }

  if (text.startsWith("/status")) {
    const row = await env.DB.prepare(
      "SELECT id, status, language FROM subscribers WHERE telegram_chat_id = ?"
    ).bind(chatId).first<{ id: string; status: string; language: string }>();
    if (!row) {
      await send("حسابك غير مرتبط بعد. أرسل /start <رمز الربط> من صفحة الاشتراك.");
      return json({ ok: true });
    }
    const prefs = await env.DB.prepare("SELECT paused FROM rss_telegram_prefs WHERE subscriber_id=?").bind(row.id).first<{ paused: number }>();
    const lang = row.language === "en" ? "en" : "ar";
    const label = row.status === "active" ? (lang === "en" ? "active" : "مفعّل") : row.status === "pending" ? (lang === "en" ? "pending admin approval" : "بانتظار موافقة الإدارة") : row.status;
    const line = (lang === "en" ? "Subscription status: " : "حالة الاشتراك: ") + label;
    const stopped = prefs?.paused === 1 ? (lang === "en" ? "\nTelegram delivery: stopped" : "\nاستقبال تيليجرام: موقوف") : "";
    await send(line + stopped);
    return json({ ok: true });
  }

  if (text.startsWith("/news")) {
    await mvpOnDemandNews(env, chatId, send);
    return json({ ok: true });
  }

  if (text.startsWith("/start")) {
    const code = text.split(/\s+/)[1] || "";
    if (!code) {
      await send("أرسل /start <رمز الربط> — الرمز يظهر في صفحة الاشتراك بعد إرسال طلبك.");
      return json({ ok: true });
    }
    // The pairing code resolves to exactly one pending/any-status subscriber.
    // Hashed exactly like createMvpLinkCode stores it (same salted prefix).
    const hash = await codeHash(code);
    const link = await env.DB.prepare(
      "SELECT subscriber_id FROM rss_link_codes WHERE code=? AND used_at IS NULL AND expires_at > ?"
    ).bind(hash, new Date().toISOString()).first<{ subscriber_id: string }>();
    if (!link) {
      await send("هذا الرمز استُخدم مسبقاً أو انتهت صلاحيته. اطلب رمزاً جديداً من صفحة الاشتراك.");
      return json({ ok: true });
    }
    const sub = await env.DB.prepare("SELECT id, language FROM subscribers WHERE id = ?").bind(link.subscriber_id).first<{ id: string; language: string }>();
    if (!sub) {
      await send("هذا الرمز غير صالح. اطلب رمزاً جديداً من صفحة الاشتراك.");
      return json({ ok: true });
    }
    await linkMvpChat(
      { chatId, env, subscriberId: sub.id, lang: sub.language === "en" ? "en" : "ar", send },
      code
    );
    return json({ ok: true });
  }

  await send("الأوامر المتاحة:\n/start <رمز> — ربط الحساب\n/status — الحالة\n/news — النشرة (للمفعّل فقط)\n/stop — إيقاف الاستلام");
  return json({ ok: true });
};
