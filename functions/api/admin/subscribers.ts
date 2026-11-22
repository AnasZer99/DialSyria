import { Env, Handler, fail, json, readJson, nowISO, checkAdmin, daysFromNow } from "../_lib";

interface SubRow {
  id: string;
  email: string;
  whatsapp: string | null;
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

  const subs = await env.DB.prepare(
    `SELECT s.*,
            (SELECT GROUP_CONCAT(t.topic, ',') FROM subscriber_topics t WHERE t.subscriber_id = s.id) AS topics_csv
     FROM subscribers s
     ORDER BY CASE s.status WHEN 'trial' THEN 0 WHEN 'active' THEN 1 ELSE 2 END, s.created_at DESC
     LIMIT 500`
  ).all<SubRow>();

  const counts = await env.DB.batch([
    env.DB.prepare("SELECT COUNT(*) AS c FROM subscribers"),
    env.DB.prepare("SELECT COUNT(*) AS c FROM subscribers WHERE status='pending'"),
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

  if (action === "activate" || action === "renew") {
    const base = sub.expires_at && new Date(sub.expires_at).getTime() > now ? new Date(sub.expires_at).getTime() : now;
    const expires = new Date(base + 30 * 24 * 3600 * 1000).toISOString();
    await env.DB.prepare("UPDATE subscribers SET status='active', expires_at=? WHERE id=?").bind(expires, id).run();
    return json({ ok: true, expires_at: expires });
  }

  if (action === "pause") {
    await env.DB.prepare("UPDATE subscribers SET status='paused' WHERE id=?").bind(id).run();
    return json({ ok: true });
  }
  if (action === "resume") {
    await env.DB.prepare("UPDATE subscribers SET status='active' WHERE id=?").bind(id).run();
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
