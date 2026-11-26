import { Env, Handler, fail, json, VALID_TOPICS } from "./_lib";

interface ArticleRow {
  id: string;
  title: string;
  summary: string | null;
  url: string;
  source: string;
  topic: string;
  scope: string;
  published_at: string | null;
  fetched_at: string;
}

const SCOPES = ["syria", "global"] as const;
// The public window is intentionally wider than the 24h ingestion window: a late
// or missed daily cron must never leave the page empty.
const WINDOW_DAYS = 7;
const DEFAULT_LIMIT = 12;
const MAX_LIMIT = 24;
const MAX_PAGE = 50;

export const onRequestGet: Handler = async ({ request, env, waitUntil }) => {
  if (!env.DB) return fail("database not bound", 500);

  const cache = caches.default;
  const cacheKey = new Request(request.url, { method: "GET" });
  const cached = await cache.match(cacheKey);
  if (cached) return cached;

  const url = new URL(request.url);
  const scopeParam = url.searchParams.get("scope");
  const topicParam = url.searchParams.get("topic");
  const pageParam = url.searchParams.get("page");
  const limitParam = url.searchParams.get("limit");

  const scope = scopeParam && (SCOPES as readonly string[]).includes(scopeParam) ? scopeParam : null;
  const topic = topicParam && (VALID_TOPICS as readonly string[]).includes(topicParam) ? topicParam : null;
  if (scopeParam && !scope) return fail("invalid scope", 400);
  if (topicParam && !topic) return fail("invalid topic", 400);

  const page = pageParam === null ? 1 : Number(pageParam);
  const limit = limitParam === null ? DEFAULT_LIMIT : Number(limitParam);
  if (!Number.isInteger(page) || page < 1 || page > MAX_PAGE) return fail("invalid page", 400);
  if (!Number.isInteger(limit) || limit < 1 || limit > MAX_LIMIT) return fail("invalid limit", 400);

  const cutoff = new Date(Date.now() - WINDOW_DAYS * 24 * 3600 * 1000).toISOString();
  const where: string[] = ["COALESCE(published_at, fetched_at) >= ?"];
  const args: unknown[] = [cutoff];
  if (scope) {
    where.push("scope = ?");
    args.push(scope);
  }
  if (topic) {
    where.push("topic = ?");
    args.push(topic);
  }
  args.push(limit + 1, (page - 1) * limit);

  const rows = await env.DB.prepare(
    `SELECT id, title, summary, url, source, topic, scope, published_at, fetched_at
     FROM articles
     WHERE ${where.join(" AND ")}
     ORDER BY COALESCE(published_at, fetched_at) DESC, title
     LIMIT ? OFFSET ?`
  )
    .bind(...args)
    .all<ArticleRow>();

  const hasMore = rows.results.length > limit;
  const res = json({
    articles: rows.results.slice(0, limit),
    page,
    limit,
    has_more: hasMore,
  });
  res.headers.set("cache-control", "public, max-age=300");
  waitUntil(cache.put(cacheKey, res.clone()));
  return res;
};
