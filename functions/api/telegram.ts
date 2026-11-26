import { Env, Handler, json, siteUrl, stagingAllowlistsValid, tgSend, tgSendLong, uuid, nowISO, type Topic } from "./_lib";
import { pickSections, digestText } from "./_digest";
import { notificationDetails, subscriberEligible } from "./_notify";
import { approveBeta, approveStagingChallenge, claimBetaStart, sendBetaConfirmation, sendStagingChallenges } from "./_beta";

interface TgUpdate {
  message?: { text?: string; chat?: { id: number; type?: string }; from?: { id?: number } };
  callback_query?: { id?:string; data?:string; from?:{id?:number}; message?:{chat?:{id:number;type?:string}} };
}

/** Webhook من تيليجرام: /start <magic_token> يربط حساب المشترك بالبوت */
export const onRequestPost: Handler = async ({ request, env }) => {
  if (!env.DB || !env.TELEGRAM_BOT_TOKEN || !env.TELEGRAM_WEBHOOK_SECRET) return json({ ok: true });
  if ((request.headers.get("x-telegram-bot-api-secret-token") || "") !== env.TELEGRAM_WEBHOOK_SECRET) {
    return new Response("unauthorized", { status: 401 });
  }
  let update: TgUpdate;
  try {
    update = (await request.json()) as TgUpdate;
  } catch {
    return json({ ok: true });
  }
  if(env.STAGING_PILOT_MODE==='1'){
    if(!stagingAllowlistsValid(env))return json({ok:true});
    const actor=update.callback_query?.from?.id ?? update.message?.from?.id;
    const invited=new Set((env.BETA_ALLOWED_TELEGRAM_IDS || '').split(',').map(x=>x.trim()));
    if(!actor || !invited.has(String(actor)))return json({ok:true});
  }
  const callback=update.callback_query;
  if(callback){
    const chat=callback.message?.chat, data=callback.data || '';
    if(!chat || chat.type!=='private' || !callback.from || callback.from.id!==chat.id)return json({ok:true});
    const approved=env.STAGING_PILOT_MODE==='1' && data.startsWith('p_') ? await approveStagingChallenge(env,data.slice(2),String(chat.id)) : env.STAGING_PILOT_MODE!=='1' && data.startsWith('b_') ? await approveBeta(env,data.slice(2),String(chat.id)) : false;
    return callback.id ? json({method:'answerCallbackQuery',callback_query_id:callback.id,text:approved?'تم التأكيد. عُد إلى المتصفح.':'انتهت صلاحية الطلب أو استُخدم مسبقاً.'}) : json({ok:true});
  }
  const msg = update.message;
  if (!msg?.chat?.id) return json({ ok: true });
  const chatId = String(msg.chat.id);
  const text = (msg.text || "").trim();
  // Only private chats may link an account or read personal notification details;
  // groups, supergroups and channels are rejected, and the sender must match the chat.
  if (msg.chat.type !== "private" || !msg.from || msg.from.id !== msg.chat.id) {
    return json({ ok: true });
  }
  if (!text.startsWith("/start")) {
    // /more <notification-id>: details of a notification owned by the linked subscriber.
    // Details come only from stored fields; nothing is fetched or invented.
    if (text.startsWith("/more")) {
      if(env.STAGING_PILOT_MODE==='1' && env.TELEGRAM_DELIVERY_ENABLED!=='1')return json({ok:true});
      const notificationId = text.split(/\s+/)[1] || "";
      const linked = await env.DB.prepare("SELECT id FROM subscribers WHERE telegram_chat_id = ?").bind(chatId).first<{ id: string }>();
      if (!linked) {
        await tgSend(env, chatId, "حسابك غير مرتبط بعد.\nاشترك من الموقع ثم اربط تيليجرام من صفحة الإدارة:\n" + siteUrl(env) + "/manage");
        return json({ ok: true });
      }
      if (!notificationId) {
        await tgSend(env, chatId, "استخدم: /more <معرف التحديث> لإظهار تفاصيل التحديث.");
        return json({ ok: true });
      }
      // Owner-scoped lookup: unknown, expired and foreign references share one safe reply.
      const details = await notificationDetails(env.DB, linked.id, notificationId);
      await tgSend(env, chatId, details ? details.text : "لا يوجد تحديث بهذا المعرف يخص حسابك.");
      return json({ ok: true });
    }
    // أمر النشرة الفورية: مرة واحدة كل 24 ساعة، ويُحتسب نسخة اليوم
    // (يُسجَّل الاستلام فيتجاوز الموعد المجدول حتى اليوم التالي)
    if (text.startsWith("/news") || text === "أخبار" || text === "الأخبار" || text === "الاخبار") {
      if(env.STAGING_PILOT_MODE==='1')return json({ok:true});
      const row = await env.DB.prepare(
        "SELECT id, language, status, last_digest_at FROM subscribers WHERE telegram_chat_id = ?"
      ).bind(chatId).first<{ id: string; language: string; status: string; last_digest_at: string | null }>();
      if (!row) {
        await tgSend(
          env,
          chatId,
          "حسابك غير مرتبط بعد.\nاشترك من الموقع ثم اربط تيليجرام من صفحة الإدارة:\n" + siteUrl(env)
        );
        return json({ ok: true });
      }
      const beta = await env.DB.prepare('SELECT created_beta FROM beta_identities WHERE subscriber_id=?').bind(row.id).first<{created_beta:number}>();
      if (beta?.created_beta === 1 || /^beta_[a-f0-9]{64}$/.test(row.id)) {
        await tgSend(env, chatId, row.language === 'en' ? 'Your updates follow your saved interests.' : 'تحديثاتك تتبع اهتماماتك المحفوظة في الموقع.');
        return json({ ok: true });
      }
      if (!(await subscriberEligible(env.DB, row.id))) {
        const arMsg =
          row.status === "pending"
            ? "اشتراكك بانتظار التفعيل من إدارة الخدمة — لن تصلك النشرة حتى تُفعَّل."
            : "اشتراكك غير مفعّل حالياً.";
        await tgSend(env, chatId, row.language === "en" ? "Your subscription is not active yet." : arMsg);
        return json({ ok: true });
      }
      const lang = (row.language === "en" ? "en" : "ar") as "ar" | "en";
      // مرة واحدة كل 24 ساعة (بعد تسليم مجدول أو طلب فوري — واحد لكل يوم)
      if (row.last_digest_at && Date.now() - new Date(row.last_digest_at).getTime() < 24 * 3600 * 1000) {
        await tgSend(
          env,
          chatId,
          lang === "en"
            ? "You've received your digest within the last 24 hours — the next one arrives at your scheduled time."
            : "استلمت نشرتك خلال آخر 24 ساعة 🗞️\nنشرتك التالية عند موعدك المحدد."
        );
        return json({ ok: true });
      }
      const topicsRes = await env.DB.prepare(
        "SELECT GROUP_CONCAT(t.topic, ',') AS csv FROM subscriber_topics t WHERE t.subscriber_id = ?"
      ).bind(row.id).first<{ csv: string | null }>();
      const topics = (topicsRes?.csv || "").split(",").filter(Boolean) as Topic[];
      const cutoff = new Date(Date.now() - 24 * 3600 * 1000).toISOString();
      const sections = await pickSections(env, lang, topics, cutoff);
      if (!sections.length) {
        await tgSend(env, chatId, lang === "en" ? "No fresh news right now — try again shortly." : "لا توجد أخبار جديدة الآن — جرّب بعد قليل.");
        return json({ ok: true });
      }
      const sent = await tgSendLong(env, chatId, digestText(lang, sections));
      if (sent) {
        // تسجيل الاستلام: يتجاوز الموعد المجدول حتى اليوم التالي
        const now = nowISO();
        await env.DB.batch([
          env.DB.prepare("UPDATE subscribers SET last_digest_at = ? WHERE id = ?").bind(now, row.id),
          env.DB.prepare(
            "INSERT INTO digests (id, subscriber_id, sent_at, topics, articles_count, status) VALUES (?, ?, ?, ?, ?, ?)"
          ).bind(uuid(), row.id, now, topics.join(","), sections.flatMap((x) => x.items).length, "telegram_ondemand"),
        ]);
      } else {
        await tgSend(env, chatId, lang === "en" ? "Sending failed, please retry." : "تعذر الإرسال الآن، جرّب بعد لحظات.");
      }
    } else {
      await tgSend(
        env,
        chatId,
        "الأوامر المتاحة:\n/news — أرسل نشرتك فوراً\n/more <معرف> — تفاصيل تحديث\n\nوستصلك نشرتك اليومية تلقائياً في الوقت الذي اخترته."
      );
    }
    return json({ ok: true });
  }

  const token = text.split(/\s+/)[1] || "";
  if(env.STAGING_PILOT_MODE==='1'){
    await sendStagingChallenges(env,chatId);
    return json({ok:true});
  }
  if(token.startsWith('b_')){
    const challenge=await claimBetaStart(env,token.slice(2),chatId);
    if(challenge) await sendBetaConfirmation(env,chatId,token.slice(2),challenge.code);
    else await tgSend(env,chatId,'انتهت صلاحية طلب الدخول أو استُخدم. ابدأ طلباً جديداً من الموقع.');
    return json({ok:true});
  }
  if (!token) {
    await tgSend(
      env,
      chatId,
      "مرحباً بك في ديل سيريا 🗞️\nأنشئ اشتراكك من الموقع ثم اربط حسابك من صفحة الإدارة:\n" + siteUrl(env) + "/manage"
    );
    return json({ ok: true });
  }
  // Linking accepts short-lived single-use tokens only. Management tokens are never
  // accepted here, and no token is ever echoed back into a Telegram message.
  const now = nowISO();
  const claimed = await env.DB.prepare(
    "UPDATE telegram_link_tokens SET used_at=? WHERE token=? AND used_at IS NULL AND expires_at > ?"
  ).bind(now, token, now).run();
  const link = claimed.meta.changes
    ? await env.DB.prepare("SELECT subscriber_id FROM telegram_link_tokens WHERE token=?").bind(token).first<{ subscriber_id: string }>()
    : null;
  if (!link) {
    await tgSend(env, chatId, "رابط الربط غير صالح أو منتهي الصلاحية. اطلب رابطاً جديداً من صفحة إدارة الاشتراك.");
    return json({ ok: true });
  }
  const conflict = await env.DB.prepare("SELECT id FROM subscribers WHERE telegram_chat_id=? AND id<>? LIMIT 1").bind(chatId, link.subscriber_id).first<{ id: string }>();
  if (conflict) {
    await tgSend(env, chatId, "هذا الحساب مرتبط بمشترك آخر. استخدم حسابك الصحيح أو تواصل مع الإدارة.");
    return json({ ok: true });
  }
  // Enforce ownership inside the write itself so simultaneous links cannot pass
  // separate preflight checks and attach one private chat to two accounts.
  const linked = await env.DB.prepare("UPDATE subscribers SET telegram_chat_id=? WHERE id=? AND NOT EXISTS (SELECT 1 FROM subscribers other WHERE other.telegram_chat_id=? AND other.id<>?) AND NOT EXISTS (SELECT 1 FROM beta_identities b WHERE b.subscriber_id=? AND b.chat_id<>?)")
    .bind(chatId,link.subscriber_id,chatId,link.subscriber_id,link.subscriber_id,chatId).run();
  if (!linked.meta.changes) {
    await tgSend(env, chatId, "هذا الحساب مرتبط بمشترك آخر أو لا يمكن تغيير الربط. تواصل مع الإدارة.");
    return json({ ok: true });
  }
  await tgSend(
    env,
    chatId,
    "تم ربط حسابك بنجاح ✓\nستصلك تحديثات اهتماماتك على تيليجرام.\nلإدارة اشتراكك:\n" + siteUrl(env) + "/manage"
  );
  // تيليجرام يطلب 200 دائماً وإلا أعاد المحاولة
  return json({ ok: true });
};
