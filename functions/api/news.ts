import { Env, Handler, fail, json } from "./_lib";

interface ArticleRow {
  id: string;
  title: string;
  summary: string | null;
  url: string;
  source: string;
  topic: string;
  scope: string;
  published_at: string | null;
}

export const onRequestGet: Handler = async ({ request, env, waitUntil }) => {
  if (!env.DB) return fail("database not bound", 500);

  // تخزين مؤقت على الحافة (10 دقائق): يقطع استعلامات D1 عن كل زائر للصفحة العامة
  const cache = caches.default;
  const cacheKey = new Request(request.url, { method: "GET" });
  const cached = await cache.match(cacheKey);
  if (cached) return cached;

  const cutoff = new Date(Date.now() - 24 * 3600 * 1000).toISOString();
  const rows = await env.DB.prepare(
    `SELECT id, title, summary, url, source, topic, scope, published_at
     FROM articles
     WHERE fetched_at > ?
     ORDER BY published_at DESC
     LIMIT 14`
  )
    .bind(cutoff)
    .all<ArticleRow>();

  const res = json({ articles: rows.results });
  res.headers.set("cache-control", "public, max-age=600");
  waitUntil(cache.put(cacheKey, res.clone()));
  return res;
};
