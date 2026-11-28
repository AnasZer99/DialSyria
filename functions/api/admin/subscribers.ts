import { Env, Handler, fail, json, readJson, nowISO, checkAdmin, daysFromNow } from "../_lib";

interface SubRow {
  id: string;
  email: string;
  whatsapp: string | null;
  telegram_chat_id: string | null;
  language: string;
  delivery_hour: number;
  status: string;
  trial_ends_at: string | null;
  expires_at: string | null;
  created_at: string;
  topics_csv: string | null;
}

async function guard({ request, env }: { request: Request; env: Env }): Promise<boolean> {
  return checkAdmin(request, env);
}

export const onRequestGet: Handler = async ({ request, env }) => {
  if (!env.DB) return fail("database not bound", 500);
  if (!(await guard({ request, env }))) return fail("unauthorized", 401);

  const now = nowISO();
  const cutoff = new Date(Date.now() - 24 * 3600 * 1000).toISOString();

  let subs;
  try {
    subs = await env.DB.prepare(
      `SELECT s.*, (p.paused = 1) AS telegram_paused,
              (SELECT GROUP_CONCAT(t.topic, ',') FROM subscriber_topics t WHERE t.subscriber_id = s.id) AS topics_csv
       FROM subscribers s
       LEFT JOIN rss_telegram_prefs p ON p.subscriber_id = s.id
       ORDER BY CASE s.status WHEN 'pending' THEN 0 WHEN 'trial' THEN 1 WHEN 'active' THEN 2 ELSE 3 END, s.created_at DESC
       LIMIT 500`
    ).bind().all<SubRow & { telegram_paused: number | null }>();
  } catch {
    // Migration 0016 (rss_telegram_prefs) may not be applied yet; fall back to
    // the legacy listing so the admin panel keeps working either way.
    subs = await env.DB.prepare(
      `SELECT s.*, NULL AS telegram_paused,
              (SELECT GROUP_CONCAT(t.topic, ',') FROM subscriber_topics t WHERE t.subscriber_id = s.id) AS topics_csv
       FROM subscribers s
       ORDER BY CASE s.status WHEN 'trial' THEN 0 WHEN 'active' THEN 1 ELSE 2 END, s.created_at DESC
       LIMIT 500`
    ).bind().all<SubRow & { telegram_paused: number | null }>();
  }

  const counts = await env.DB.batch([
    env.DB.prepare("SELECT COUNT(*) AS c FROM subscribers").bind(),
    env.DB.prepare("SELECT COUNT(*) AS c FROM subscribers WHERE status='pending'").bind(),
    env.DB.prepare("SELECT COUNT(*) AS c FROM subscribers WHERE status='active' AND (expires_at IS NULL OR expires_at > ?)").bind(now),
    env.DB.prepare("SELECT COUNT(*) AS c FROM articles WHERE fetched_at > ?").bind(cutoff),
    env.DB.prepare("SELECT COUNT(*) AS c FROM subscribers WHERE status='trial' AND (trial_ends_at IS NULL OR trial_ends_at > ?)").bind(now),
  ]);

  const total = (counts[0].results as unknown as { c: number }[])[0]?.c ?? 0;
  const pending = (counts[1].results as unknown as { c: number }[])[0]?.c ?? 0;
  const active = (counts[2].results as unknown as { c: number }[])[0]?.c ?? 0;
  const articles = (counts[3].results as unknown as { c: number }[])[0]?.c ?? 0;
  const trial = (counts[4].results as unknown as { c: number }[])[0]?.c ?? 0;

  return json({
    subscribers: subs.results.map((s) => ({
      id: s.id,
      email: s.email,
      whatsapp: s.whatsapp,
      language: s.language === "en" ? "en" : "ar",
      delivery_hour: s.delivery_hour,
      status: s.status,
      trial_ends_at: s.trial_ends_at,
      expires_at: s.expires_at,
      created_at: s.created_at,
      telegram_linked: !!s.telegram_chat_id,
      telegram_paused: s.telegram_paused === 1,
      topics: (s.topics_csv || "").split(",").filter(Boolean),
    })),
    stats: {
      total,
      pending,
      trial,
      active,
      expired: total - pending - trial - active,
      articles_24h: articles,
    },
  });
};

export const onRequestPost: Handler = async ({ request, env }) => {
  if (!env.DB) return fail("database not bound", 500);
  if (!(await guard({ request, env }))) return fail("unauthorized", 401);

  const { id, action } = await readJson<{ id?: string; action?: string }>(request);
  if (!id || !action) return fail("id and action required");

  const sub = await env.DB.prepare("SELECT id, status, expires_at FROM subscribers WHERE id = ?").bind(id).first<{ id: string; status: string; expires_at: string | null }>();
  if (!sub) return fail("subscriber not found", 404);

  const now = Date.now();

  // Approve a pending request: pending → active with a 30-day term. The write is
  // conditioned on the current status, so a double-click or replayed request
  // cannot extend the term twice.
  if (action === "approve") {
    const expires = new Date(now + 30 * 24 * 3600 * 1000).toISOString();
    const approved = await env.DB.prepare(
      "UPDATE subscribers SET status='active', expires_at=? WHERE id=? AND status='pending'"
    ).bind(expires, id).run();
    if (!approved.meta.changes) return json({ ok: true, already: true, status: sub.status });
    await setTelegramPaused(env, id, false);
    return json({ ok: true, status: "active", expires_at: expires });
  }

  // Reject a pending request: pending → cancelled (no deletion of data).
  if (action === "reject") {
    const rejected = await env.DB.prepare(
      "UPDATE subscribers SET status='cancelled' WHERE id=? AND status='pending'"
    ).bind(id).run();
    if (!rejected.meta.changes) return json({ ok: true, already: true, status: sub.status });
    return json({ ok: true, status: "cancelled" });
  }

  if (action === "activate" || action === "renew") {
    const base = sub.expires_at && new Date(sub.expires_at).getTime() > now ? new Date(sub.expires_at).getTime() : now;
    const expires = new Date(base + 30 * 24 * 3600 * 1000).toISOString();
    await env.DB.prepare("UPDATE subscribers SET status='active', expires_at=? WHERE id=?").bind(expires, id).run();
    await setTelegramPaused(env, id, false);
    return json({ ok: true, expires_at: expires });
  }

  if (action === "pause") {
    // A beta pause revokes its consent baseline even when initiated by an operator.
    await env.DB.prepare("UPDATE beta_identities SET notifications_enabled_at=NULL WHERE subscriber_id=? AND created_beta=1").bind(id).run();
    await env.DB.prepare("UPDATE subscribers SET status='paused' WHERE id=?").bind(id).run();
    await setTelegramPaused(env, id, true);
    return json({ ok: true });
  }
  if (action === "resume") {
    await env.DB.prepare("UPDATE subscribers SET status='active' WHERE id=?").bind(id).run();
    await setTelegramPaused(env, id, false);
    return json({ ok: true });
  }
  if (action === "delete") {
    await env.DB.batch([
      env.DB.prepare("DELETE FROM digests WHERE subscriber_id=?").bind(id),
      env.DB.prepare("DELETE FROM subscriber_topics WHERE subscriber_id=?").bind(id),
      env.DB.prepare("DELETE FROM subscribers WHERE id=?").bind(id),
    ]);
    return json({ ok: true });
  }

  return fail("unknown action");
};

/** Best-effort Telegram delivery preference update (migration 0016 table). */
async function setTelegramPaused(env: Env, subscriberId: string, paused: boolean): Promise<void> {
  try {
    await env.DB.prepare(
      "INSERT INTO rss_telegram_prefs (subscriber_id, paused, updated_at) VALUES (?,?,?) ON CONFLICT(subscriber_id) DO UPDATE SET paused=excluded.paused, updated_at=excluded.updated_at"
    ).bind(subscriberId, paused ? 1 : 0, nowISO()).run();
  } catch {
    // rss_telegram_prefs may be absent until migration 0016 is applied.
  }
}
