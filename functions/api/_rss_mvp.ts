import { Env, nowISO, uuid, damascusHour, type Topic } from "./_lib";
import { pickSections } from "./_digest";

/**
 * RSS MVP subscriber journey helpers: Telegram pairing codes, the dedicated
 * MVP bot transport (separate from the legacy Beta bot), and Telegram delivery
 * built exclusively from stored `articles`.
 *
 * Safety properties:
 * - Real sending requires TELEGRAM_MVP_BOT_TOKEN; without it nothing is sent
 *   and delivery is reported as `no_provider` (mock transport comes from
 *   injected fetchers in tests).
 * - One digest per subscriber per 24h window, claimed atomically through a
 *   conditional UPDATE on `subscribers.last_digest_at` BEFORE sending.
 * - Empty digests are never sent; delivery failures release the claim so the
 *   next attempt can retry.
 * - pending/paused/expired/cancelled subscribers never receive anything.
 */

export const MVP_CODE_TTL_MS = 2 * 3600_000;
const MVP_MAX_TEXT = 3800;

const S = {
  ar: {
    header: "🗞 نشرة ديل سيريا",
    empty: "لا توجد أخبار جديدة الآن — جرّب بعد قليل.",
    paused: "استقبال النشرة موقوف من هذا الحساب (/stop). أعد تفعيله من الإدارة.",
    pending: "اشتراكك بانتظار موافقة الإدارة — لن تصلك النشرة حتى يتم تفعيلك.",
    expired: "انتهت صلاحية اشتراكك — لن تصلك النشرة حتى يجدد المدير اشتراكك.",
    notLinked: "حسابك غير مرتبط. افتح البوت من صفحة الاشتراك أو أرسل /start مع رمز الربط.",
    already24h: "استلمت نشرتك خلال آخر 24 ساعة — نشرتك التالية في موعدك المحدد.",
    linked: "تم ربط حسابك بنجاح ✓\nستصلك نشرة الأخبار عبر تيليجرام بعد تفعيل الاشتراك من الإدارة.",
    used: "هذا الرمز استُخدم مسبقاً أو انتهت صلاحيته. اطلب رمزاً جديداً من صفحة الاشتراك.",
    conflict: "هذه المحادثة مرتبطة باشتراك آخر. لا يمكن ربطها بحساب ثانٍ.",
    stopped: "تم إيقاف استقبال النشرة (/stop). لن تصلك نشرات حتى يعيد تفعيلها المدير.",
    statusPrefix: "حالة اشتراكك:",
    help: "الأوامر:\n/start <رمز> — ربط الحساب\n/status — حالة الاشتراك\n/news — النشرة (مفعّل فقط)\n/stop — إيقاف الاستلام",
  },
  en: {
    header: "🗞 DialSyria digest",
    empty: "No fresh news right now — try again shortly.",
    paused: "Telegram delivery is stopped for this account (/stop). Re-enable it from the admin.",
    pending: "Your subscription awaits admin approval — the digest starts after activation.",
    expired: "Your subscription has expired — the digest resumes once the admin renews it.",
    notLinked: "Account not linked. Open the bot from the subscribe screen or send /start with a pairing code.",
    already24h: "You already received a digest within the last 24 hours — the next one arrives at your scheduled time.",
    linked: "Account linked ✓\nYou will receive the news digest on Telegram once the admin activates your subscription.",
    used: "This code was already used or expired. Request a new one from the subscribe screen.",
    conflict: "This chat is already linked to another subscription and cannot be linked again.",
    stopped: "Digest delivery is stopped (/stop). It stays off until an admin re-enables it.",
    statusPrefix: "Subscription status:",
    help: "Commands:\n/start <code> — link account\n/status — subscription status\n/news — digest (active only)\n/stop — stop delivery",
  },
} as const;

/** Dedicated MVP bot transport; returns false when no token is configured. */
export async function mvpSend(env: Env, chatId: string, text: string, fetcher: typeof fetch = fetch): Promise<boolean> {
  if (!env.TELEGRAM_MVP_BOT_TOKEN) return false;
  try {
    const res = await fetcher(`https://api.telegram.org/bot${env.TELEGRAM_MVP_BOT_TOKEN}/sendMessage`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ chat_id: chatId, text, link_preview_options: { is_disabled: true } }),
      signal: AbortSignal.timeout(10000),
    });
    return res.ok;
  } catch {
    return false;
  }
}

/** The pairing code is short-lived and single-use; only its SHA-256 is stored. */
export async function codeHash(code: string): Promise<string> {
  const data = new TextEncoder().encode("rss-mvp-link:" + code.trim().toUpperCase());
  const digest = await crypto.subtle.digest("SHA-256", data);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

function generateCode(): string {
  // 8 readable characters, no confusing glyphs (no 0/O/1/I).
  const alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  const bytes = new Uint8Array(8);
  crypto.getRandomValues(bytes);
  return [...bytes].map((b) => alphabet[b % alphabet.length]).join("");
}

/** Create a single-use pairing code bound to one subscriber. Only the SHA-256
 * of the code is stored; the raw code is shown once in the subscribe response. */
export async function createMvpLinkCode(env: Env, subscriberId: string): Promise<string> {
  const code = generateCode();
  const now = nowISO();
  await env.DB.prepare(
    "INSERT OR REPLACE INTO rss_link_codes (code, subscriber_id, created_at, expires_at, used_at) VALUES (?,?,?,?,NULL)"
  ).bind(await codeHash(code), subscriberId, now, new Date(Date.now() + MVP_CODE_TTL_MS).toISOString()).run();
  return code;
}

export interface MvpWebhookContext {
  chatId: string;
  env: Env;
  subscriberId: string;
  lang: "ar" | "en";
  send: (text: string) => Promise<unknown>;
}

/** Bind a private chat to the subscriber owning a valid, unused code. */
export async function linkMvpChat(ctx: MvpWebhookContext, code: string): Promise<void> {
  const hash = await codeHash(code);
  const now = nowISO();
  const claimed = await ctx.env.DB.prepare(
    "UPDATE rss_link_codes SET used_at=? WHERE code=? AND used_at IS NULL AND expires_at > ?"
  ).bind(now, hash, now).run();
  if (!claimed.meta.changes) {
    await ctx.send(S[ctx.lang].used);
    return;
  }
  const link = await ctx.env.DB.prepare("SELECT subscriber_id FROM rss_link_codes WHERE code=?").bind(hash).first<{ subscriber_id: string }>();
  if (!link || link.subscriber_id !== ctx.subscriberId) {
    await ctx.send(S[ctx.lang].used);
    return;
  }
  // One chat ↔ one account: refuse when the chat belongs to another subscriber.
  const conflict = await ctx.env.DB.prepare(
    "SELECT id FROM subscribers WHERE telegram_chat_id=? AND id<>? LIMIT 1"
  ).bind(ctx.chatId, ctx.subscriberId).first<{ id: string }>();
  if (conflict) {
    await ctx.send(S[ctx.lang].conflict);
    return;
  }
  const bound = await ctx.env.DB.prepare(
    "UPDATE subscribers SET telegram_chat_id=? WHERE id=? AND NOT EXISTS (SELECT 1 FROM subscribers other WHERE other.telegram_chat_id=? AND other.id<>?) AND NOT EXISTS (SELECT 1 FROM beta_identities b WHERE b.chat_id=? AND b.subscriber_id<>?)"
  ).bind(ctx.chatId, ctx.subscriberId, ctx.chatId, ctx.subscriberId, ctx.chatId, ctx.subscriberId).run();
  if (!bound.meta.changes) {
    await ctx.send(S[ctx.lang].conflict);
    return;
  }
  await ctx.send(S[ctx.lang].linked);
}

export interface MvpDeliveryResult {
  sent: boolean;
  reason: "sent" | "empty" | "already_24h" | "not_eligible" | "paused" | "no_provider" | "send_failed";
  articlesCount: number;
}

/** Plain-text MVP digest: every item keeps its stored publisher URL. */
function mvpDigestText(lang: "ar" | "en", sections: { title: string; items: { title: string; url: string; source: string; published_at: string | null }[] }[]): string {
  const L = S[lang];
  let out = `${L.header}\n${new Date().toISOString().slice(0, 10)}\n\n`;
  for (const sec of sections) {
    out += `■ ${sec.title}\n`;
    sec.items.forEach((a, i) => {
      out += `${i + 1}. ${a.title}\n   ${a.source}${a.published_at ? " · " + a.published_at.slice(0, 10) : ""}\n   ${a.url}\n`;
    });
    out += "\n";
  }
  return out.trim();
}

/** Deliver one Telegram digest to a single subscriber from stored articles only. */
export async function deliverMvpNews(
  env: Env,
  subscriber: { id: string; chatId: string; language: string; topics: Topic[]; lastDigestAt: string | null },
  opts: { trigger?: "ondemand" | "scheduled"; fetcher?: typeof fetch } = {}
): Promise<MvpDeliveryResult> {
  const lang = (subscriber.language === "en" ? "en" : "ar") as "ar" | "en";
  const now = nowISO();
  const cutoff = new Date(Date.now() - 24 * 3600_000).toISOString();

  const prefs = await env.DB.prepare("SELECT paused FROM rss_telegram_prefs WHERE subscriber_id=?").bind(subscriber.id).first<{ paused: number }>();
  if (prefs?.paused === 1) return { sent: false, reason: "paused", articlesCount: 0 };

  const statusRow = await env.DB.prepare("SELECT status, expires_at FROM subscribers WHERE id=?").bind(subscriber.id).first<{ status: string; expires_at: string | null }>();
  if (statusRow?.status !== "active") return { sent: false, reason: "not_eligible", articlesCount: 0 };
  // An expired term is not deliverable even while status is still 'active'
  // (covers the concurrent path directly, not just the caller's own checks).
  if (statusRow.expires_at && new Date(statusRow.expires_at).getTime() <= Date.now()) {
    return { sent: false, reason: "not_eligible", articlesCount: 0 };
  }

  const sections = await pickSections(env, lang, subscriber.topics, cutoff);
  const picked = sections.flatMap((s) => s.items);
  if (!sections.length || !picked.length) {
    await env.DB.prepare(
      "INSERT INTO digests (id, subscriber_id, sent_at, topics, articles_count, status) VALUES (?,?,?,?,?,?)"
    ).bind(uuid(), subscriber.id, now, subscriber.topics.join(","), 0, "mvp_no_new_articles").run();
    await mvpSend(env, subscriber.chatId, S[lang].empty, opts.fetcher);
    return { sent: false, reason: "empty", articlesCount: 0 };
  }

  // Atomic per-subscriber claim: one digest per 24h window, concurrent-safe.
  const claimed = await env.DB.prepare(
    "UPDATE subscribers SET last_digest_at=? WHERE id=? AND (last_digest_at IS NULL OR last_digest_at < ?)"
  ).bind(now, subscriber.id, cutoff).run();
  if (!claimed.meta.changes) return { sent: false, reason: "already_24h", articlesCount: 0 };

  let text = mvpDigestText(lang, sections);
  if (text.length > MVP_MAX_TEXT) text = text.slice(0, MVP_MAX_TEXT) + "\n…";
  const sent = await mvpSend(env, subscriber.chatId, text, opts.fetcher);
  const status = sent ? "mvp_sent" : "mvp_send_failed";
  await env.DB.prepare(
    "INSERT INTO digests (id, subscriber_id, sent_at, topics, articles_count, status) VALUES (?,?,?,?,?,?)"
  ).bind(uuid(), subscriber.id, now, subscriber.topics.join(","), picked.length, status).run();
  if (!sent) {
    // Release the claim so a retry can attempt delivery again.
    await env.DB.prepare("UPDATE subscribers SET last_digest_at=? WHERE id=?").bind(subscriber.lastDigestAt, subscriber.id).run();
    return { sent: false, reason: "send_failed", articlesCount: picked.length };
  }
  return { sent: true, reason: "sent", articlesCount: picked.length };
}

/** Scheduled MVP pass: delivers to subscribers whose chosen Damascus hour is due. */
export async function runMvpDigest(env: Env): Promise<{ due: number; sent: number; failed: number; skipped: Record<string, number> }> {
  const result = { due: 0, sent: 0, failed: 0, skipped: {} as Record<string, number> };
  if (!env.RSS_MVP_MODE || env.RSS_MVP_MODE !== "1") return result;
  const hour = damascusHour();
  const cutoff = new Date(Date.now() - 24 * 3600_000).toISOString();
  const due = await env.DB.prepare(
    `SELECT s.id, s.email, s.language, s.telegram_chat_id,
            (SELECT GROUP_CONCAT(t.topic, ',') FROM subscriber_topics t WHERE t.subscriber_id = s.id) AS topics_csv
     FROM subscribers s
     WHERE s.delivery_hour = ? AND s.status = 'active' AND s.telegram_chat_id IS NOT NULL
       AND (s.expires_at IS NULL OR s.expires_at > ?)
       AND (s.last_digest_at IS NULL OR s.last_digest_at < ?)
       AND NOT EXISTS (SELECT 1 FROM rss_telegram_prefs p WHERE p.subscriber_id = s.id AND p.paused = 1)
       AND NOT EXISTS (SELECT 1 FROM beta_identities b WHERE b.subscriber_id = s.id AND b.created_beta = 1)
     LIMIT 100`
  ).bind(hour, nowISO(), cutoff).all<{ id: string; email: string; language: string; telegram_chat_id: string; topics_csv: string | null }>();

  for (const row of due.results) {
    result.due++;
    const topics = (row.topics_csv || "").split(",").filter(Boolean) as Topic[];
    const outcome = await deliverMvpNews(
      env,
      { id: row.id, chatId: row.telegram_chat_id, language: row.language, topics, lastDigestAt: null },
      { trigger: "scheduled" }
    );
    if (outcome.sent) result.sent++;
    else if (outcome.reason === "send_failed") result.failed++;
    else result.skipped[outcome.reason] = (result.skipped[outcome.reason] || 0) + 1;
  }
  return result;
}

/** /news for one chat-bound subscriber; honours the same 24h + eligibility rules. */
export async function mvpOnDemandNews(
  env: Env,
  chatId: string,
  send: (text: string) => Promise<unknown>
): Promise<MvpDeliveryResult> {
  const row = await env.DB.prepare(
    "SELECT id, language, status, expires_at, telegram_chat_id, last_digest_at FROM subscribers WHERE telegram_chat_id = ?"
  ).bind(chatId).first<{ id: string; language: string; status: string; expires_at: string | null; telegram_chat_id: string; last_digest_at: string | null }>();
  const lang = (row?.language === "en" ? "en" : "ar") as "ar" | "en";
  if (!row) {
    await send(S[lang].notLinked);
    return { sent: false, reason: "not_eligible", articlesCount: 0 };
  }
  const prefs = await env.DB.prepare("SELECT paused FROM rss_telegram_prefs WHERE subscriber_id=?").bind(row.id).first<{ paused: number }>();
  if (prefs?.paused === 1) {
    await send(S[lang].paused);
    return { sent: false, reason: "paused", articlesCount: 0 };
  }
  if (row.status !== "active") {
    await send(S[lang].pending);
    return { sent: false, reason: "not_eligible", articlesCount: 0 };
  }
  if (row.expires_at && new Date(row.expires_at).getTime() <= Date.now()) {
    await send(S[lang].expired);
    return { sent: false, reason: "not_eligible", articlesCount: 0 };
  }
  if (row.last_digest_at && Date.now() - new Date(row.last_digest_at).getTime() < 24 * 3600_000) {
    await send(S[lang].already24h);
    return { sent: false, reason: "already_24h", articlesCount: 0 };
  }
  const topicsRes = await env.DB.prepare(
    "SELECT GROUP_CONCAT(t.topic, ',') AS csv FROM subscriber_topics t WHERE t.subscriber_id = ?"
  ).bind(row.id).first<{ csv: string | null }>();
  const topics = (topicsRes?.csv || "").split(",").filter(Boolean) as Topic[];
  const outcome = await deliverMvpNews(
    env,
    { id: row.id, chatId, language: row.language, topics, lastDigestAt: row.last_digest_at },
    { trigger: "ondemand" }
  );
  if (outcome.reason === "already_24h") await send(S[lang].already24h);
  else if (outcome.reason === "empty") { /* empty notice already sent */ }
  else if (outcome.reason === "send_failed") await send(lang === "en" ? "Sending failed, please retry." : "تعذر الإرسال الآن، جرّب بعد لحظات.");
  return outcome;
}
