import { Env, Handler, fail, json, readJson, nowISO, VALID_TOPICS, type Topic } from "./_lib";

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
  magic_expires?: string | null;
  telegram_chat_id?: string | null;
}

async function findByToken(env: Env, token: string): Promise<{ row: SubRow; topics: string[] } | null> {
  const row = await env.DB.prepare("SELECT * FROM subscribers WHERE magic_token = ?").bind(token).first<SubRow>();
  if (!row) return null;
  if (row.magic_expires && row.magic_expires < nowISO()) return null;
  const topics = await env.DB.prepare("SELECT topic FROM subscriber_topics WHERE subscriber_id = ?").bind(row.id).all<{ topic: string }>();
  return { row, topics: topics.results.map((r) => r.topic) };
}

function tokenFromUrl(request: Request): string {
  return new URL(request.url).searchParams.get("token") || "";
}

export const onRequestGet: Handler = async ({ request, env }) => {
  if (!env.DB) return fail("database not bound", 500);
  const token = tokenFromUrl(request);
  if (!token) return fail("missing token", 401);
  const found = await findByToken(env, token);
  if (!found) return fail("invalid or expired token", 401);
  const { row, topics } = found;
  return json({
    subscriber: {
      id: row.id,
      email: row.email,
      whatsapp: row.whatsapp,
      language: row.language === "en" ? "en" : "ar",
      delivery_hour: row.delivery_hour,
      status: row.status,
      trial_ends_at: row.trial_ends_at,
      expires_at: row.expires_at,
      created_at: row.created_at,
      topics,
      telegram_chat_id: row.telegram_chat_id ?? null,
    },
  });
};

export const onRequestPatch: Handler = async ({ request, env }) => {
  if (!env.DB) return fail("database not bound", 500);
  const token = tokenFromUrl(request);
  if (!token) return fail("missing token", 401);
  const found = await findByToken(env, token);
  if (!found) return fail("invalid or expired token", 401);

  const body = await readJson<{ topics?: string[]; delivery_hour?: number; language?: string; whatsapp?: string | null }>(request);

  if (Array.isArray(body.topics)) {
    const topics = [...new Set(body.topics)].filter((x): x is Topic => (VALID_TOPICS as readonly string[]).includes(x));
    if (topics.length < 1 || topics.length > 3) return fail("choose 1 to 3 topics");
    await env.DB.batch([
      env.DB.prepare("DELETE FROM subscriber_topics WHERE subscriber_id=?").bind(found.row.id),
      ...topics.map((x) =>
        env.DB.prepare("INSERT INTO subscriber_topics (subscriber_id, topic) VALUES (?, ?)").bind(found.row.id, x)
      ),
    ]);
  }

  const sets: string[] = [];
  const vals: (string | number)[] = [];
  if (typeof body.delivery_hour === "number" && Number.isInteger(body.delivery_hour) && body.delivery_hour >= 0 && body.delivery_hour <= 23) {
    sets.push("delivery_hour=?");
    vals.push(body.delivery_hour);
  }
  if (body.language === "ar" || body.language === "en") {
    sets.push("language=?");
    vals.push(body.language);
  }
  if (typeof body.whatsapp === "string" || body.whatsapp === null) {
    sets.push("whatsapp=?");
    vals.push(body.whatsapp === null ? null : body.whatsapp.trim().slice(0, 30));
  }
  if (sets.length) {
    vals.push(found.row.id);
    await env.DB.prepare(`UPDATE subscribers SET ${sets.join(", ")} WHERE id=?`).bind(...vals).run();
  }

  return json({ ok: true });
};

export const onRequestDelete: Handler = async ({ request, env }) => {
  if (!env.DB) return fail("database not bound", 500);
  const token = tokenFromUrl(request);
  if (!token) return fail("missing token", 401);
  const found = await findByToken(env, token);
  if (!found) return fail("invalid or expired token", 401);
  await env.DB.prepare("UPDATE subscribers SET status='cancelled' WHERE id=?").bind(found.row.id).run();
  return json({ ok: true });
};
