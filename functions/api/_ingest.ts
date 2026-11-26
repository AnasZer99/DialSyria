import { Env, nowISO, uuid, damascusHour, damascusTodayStartISO, type Topic, VALID_TOPICS } from "./_lib";
import {
  RSS_SOURCES,
  INGEST_LOOKBACK_HOURS,
  ARTICLE_RETENTION_DAYS,
  MAX_ITEMS_PER_FEED,
  type RssSource,
} from "./_rss_sources";
import { canonicalUrl, classifyTopic, detectScope } from "./_classify";

/** Backwards-compatible shape used by the local demo and older tooling. */
export interface FeedDef {
  topic: Topic;
  scope: "syria" | "global";
  url: string;
  source?: string;
}

export const FEEDS: FeedDef[] = RSS_SOURCES.filter((s) => s.enabled).map((s) => ({
  topic: s.topic,
  scope: s.scope,
  url: s.url,
  source: s.name,
}));

interface RssItem {
  title: string;
  link: string;
  pubDate?: string;
  description?: string;
  source?: string;
  sourceUrl?: string;
}

const NAMED_ENTITIES: Record<string, string> = {
  nbsp: " ", quot: '"', apos: "'", lt: "<", gt: ">",
  hellip: "…", mdash: "—", ndash: "–", ldquo: '"', rdquo: '"', lsquo: "'", rsquo: "'",
  laquo: "«", raquo: "»", zwnj: "\u200C", lrm: "\u200E", rlm: "\u200F",
  bull: "•", middot: "·", copy: "©", reg: "®", trade: "™", deg: "°", times: "×",
};

function safeCodePoint(cp: number): string {
  try {
    return String.fromCodePoint(cp);
  } catch {
    return " ";
  }
}

/** فكّ كيانات HTML بثلاث طبقات: المهرّبة مرتين والرقمية والمسماة */
function unescape(v: string): string {
  let out = v;
  let prev = "";
  for (let i = 0; i < 3 && out !== prev; i++) {
    prev = out;
    out = out
      .replace(/&#x([0-9a-fA-F]+);/g, (_, h: string) => safeCodePoint(parseInt(h, 16)))
      .replace(/&#(\d+);/g, (_, d: string) => safeCodePoint(parseInt(d, 10)))
      .replace(/&([a-zA-Z][a-zA-Z0-9]{1,10});/g, (m: string, name: string) => {
        const k = name.toLowerCase();
        if (k === "amp") return "&";
        return NAMED_ENTITIES[k] ?? " ";
      });
  }
  return out;
}

function pick(block: string, tag: string): string {
  const m = block.match(new RegExp(`<${tag}(?:\\s[^>]*)?>([\\s\\S]*?)</${tag}>`, "i"));
  if (!m) return "";
  let v = m[1].trim();
  const cdata = v.match(/^<!\[CDATA\[([\s\S]*)\]\]>$/);
  if (cdata) v = cdata[1];
  v = unescape(v);
  return v.replace(/<[^>]*>/g, " ").replace(/\s+/g, " ").trim();
}

/**
 * Parse RSS/RDF/Atom items. Unlike the legacy 12-item cap this reads up to
 * `maxItems` (default 100) so a busy daily feed cannot silently lose today's
 * stories. Attribute-bearing <item rdf:about="…"> tags are supported too.
 */
export function parseFeed(xml: string, maxItems = MAX_ITEMS_PER_FEED): RssItem[] {
  const items: RssItem[] = [];
  const blocks = xml.match(/<(?:item|entry)(?:\s[^>]*)?>[\s\S]*?<\/(?:item|entry)>/g) || [];
  const cap = Math.max(0, Math.min(MAX_ITEMS_PER_FEED, maxItems));
  for (const b of blocks.slice(0, cap)) {
    let title = pick(b, "title");
    let link = pick(b, "link");
    if (!link) {
      // Atom: <link href="…" rel="alternate"/>
      const href = b.match(/<link\s[^>]*href=["']([^"']+)["']/i)?.[1];
      if (href) link = unescape(href);
    }
    if (!title || !link || !/^https?:\/\//.test(link)) continue;
    items.push({
      title,
      link,
      pubDate: pick(b, "pubDate") || pick(b, "published") || pick(b, "updated") || undefined,
      description: pick(b, "description") || pick(b, "summary") || undefined,
      source: pick(b, "source") || undefined,
      sourceUrl: unescape(b.match(/<source\s+[^>]*url=["']([^"']+)["']/i)?.[1] || "") || undefined,
    });
  }
  return items;
}

function cleanSummary(desc: string | undefined): string | null {
  if (!desc) return null;
  const s = desc.replace(/<[^>]*>/g, " ").replace(/\s+/g, " ").trim();
  if (s.length < 40 || s.length > 400) return null;
  if (/google news|view full coverage|مزيد من التغطية/i.test(s)) return null;
  return s;
}

function arabicTitle(title: string): boolean {
  const arabicChars = (title.match(/[\u0600-\u06FF]/g) || []).length;
  const latinChars = (title.match(/[A-Za-z]/g) || []).length;
  return arabicChars >= 5 && latinChars <= arabicChars;
}

export interface IngestionSourceResult {
  id: string;
  name: string;
  status: "ok" | "http_error" | "timeout" | "empty" | "parse_error";
  httpStatus: number | null;
  parsed: number;
  recent: number;
  inserted: number;
  error: string | null;
}

export interface IngestionResult {
  ok: boolean;
  skipped?: "already_ran_today";
  inserted: number;
  feeds_ok: number;
  feeds_fail: number;
  failed: string[];
  sources: IngestionSourceResult[];
}

interface PreparedArticle {
  id: string;
  sourceId: string;
  title: string;
  summary: string | null;
  url: string;
  source: string;
  topic: Topic;
  scope: "syria" | "global";
  published_at: string | null;
  fetched_at: string;
}

const MAX_XML_BYTES = 900_000;
const DB_BATCH_SIZE = 25;

function chunk<T>(rows: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < rows.length; i += size) out.push(rows.slice(i, i + size));
  return out;
}

async function fetchFeed(url: string, fetcher: typeof fetch): Promise<{ status: number; xml: string }> {
  const res = await fetcher(url, {
    signal: AbortSignal.timeout(15000),
    headers: {
      "user-agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36",
      accept: "application/rss+xml, application/xml, text/xml, */*",
    },
  });
  if (!res.ok) return { status: res.status, xml: "" };
  const text = await res.text();
  return { status: res.status, xml: text.slice(0, MAX_XML_BYTES) };
}

/**
 * Daily ingestion: RSS sources → fetch → parse → normalize → classify → dedupe → D1.
 * One source failure never stops the others. A successful run for the current
 * Damascus day is a no-op unless `force` is set (cron retries cannot duplicate).
 */
export async function runIngestion(
  env: Env,
  opts: { force?: boolean; fetcher?: typeof fetch; sources?: RssSource[] } = {}
): Promise<IngestionResult> {
  const started = nowISO();
  const fetcher = opts.fetcher || fetch;
  const sources = opts.sources || RSS_SOURCES.filter((s) => s.enabled);
  const result: IngestionResult = { ok: true, inserted: 0, feeds_ok: 0, feeds_fail: 0, failed: [], sources: [] };

  if (!opts.force) {
    // Skip only when the latest run for the current Damascus day finished cleanly.
    // A partial run (some feeds failed) may be retried the same day: URL
    // canonicalisation + the UNIQUE constraint keep the retry duplicate-free.
    const last = await env.DB.prepare(
      "SELECT started_at, feeds_fail FROM ingestion_runs WHERE started_at >= ? ORDER BY started_at DESC LIMIT 1"
    )
      .bind(damascusTodayStartISO())
      .first<{ started_at: string; feeds_fail: number }>();
    if (last && Number(last.feeds_fail ?? 0) === 0) return { ...result, skipped: "already_ran_today" };
  }

  const cutoff = Date.now() - INGEST_LOOKBACK_HOURS * 3600_000;
  const seen = new Set<string>();
  const prepared: PreparedArticle[] = [];
  const perSource: Array<{ source: RssSource; stats: IngestionSourceResult }> = [];

  for (const source of sources) {
    const stats: IngestionSourceResult = {
      id: source.id,
      name: source.name,
      status: "ok",
      httpStatus: null,
      parsed: 0,
      recent: 0,
      inserted: 0,
      error: null,
    };
    try {
      const { status, xml } = await fetchFeed(source.url, fetcher);
      stats.httpStatus = status;
      if (status !== 200) {
        stats.status = "http_error";
        stats.error = `HTTP ${status}`;
        result.feeds_fail++;
        result.failed.push(`${source.id} :: HTTP ${status}`);
        perSource.push({ source, stats });
        continue;
      }
      const items = parseFeed(xml, MAX_ITEMS_PER_FEED);
      stats.parsed = items.length;
      if (!items.length) {
        stats.status = "empty";
        result.feeds_fail++;
        result.failed.push(`${source.id} :: no items`);
        perSource.push({ source, stats });
        continue;
      }
      for (const it of items) {
        if (!arabicTitle(it.title)) continue;
        let title = it.title;
        let itemSource = it.source || "";
        if (!itemSource && title.includes(" - ")) {
          const parts = title.split(" - ");
          const tail = parts.pop()!.trim();
          if (tail.length >= 2) {
            itemSource = tail;
            title = parts.join(" - ").trim();
          }
        }
        const publishedAt = it.pubDate ? new Date(it.pubDate) : null;
        const publishedISO = publishedAt && Number.isFinite(publishedAt.getTime()) ? publishedAt.toISOString() : null;
        if (publishedISO && Date.parse(publishedISO) < cutoff) continue;
        const url = canonicalUrl(it.link);
        if (!url || seen.has(url)) continue;
        const topic = classifyTopic(title) ?? source.topic;
        if (!VALID_TOPICS.includes(topic)) continue;
        const scope = detectScope(title, source.scope);
        seen.add(url);
        stats.recent++;
        prepared.push({
          id: uuid(),
          sourceId: source.id,
          title,
          summary: cleanSummary(it.description),
          url,
          source: itemSource || source.name,
          topic,
          scope,
          published_at: publishedISO,
          fetched_at: started,
        });
      }
      result.feeds_ok++;
    } catch (e) {
      const message = e instanceof Error ? e.message : "unknown error";
      stats.status = /timed out|abort/i.test(message) ? "timeout" : "parse_error";
      stats.error = message.slice(0, 120);
      result.feeds_fail++;
      result.failed.push(`${source.id} :: ${stats.error}`);
    }
    perSource.push({ source, stats });
  }

  // Insert in bounded batches: one binding call per chunk keeps subrequests low.
  for (const group of chunk(prepared, DB_BATCH_SIZE)) {
    const statements = group.map((a) =>
      env.DB.prepare(
        "INSERT OR IGNORE INTO articles (id, title, summary, url, source, topic, scope, published_at, fetched_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)"
      ).bind(a.id, a.title, a.summary, a.url, a.source, a.topic, a.scope, a.published_at, a.fetched_at)
    );
    const res = await env.DB.batch(statements);
    group.forEach((a, i) => {
      const changes = res[i]?.meta?.changes ?? 0;
      result.inserted += changes;
      const owner = perSource.find((p) => p.source.id === a.sourceId)?.stats;
      if (owner) owner.inserted += changes;
    });
  }

  await env.DB.prepare(
    "INSERT INTO ingestion_runs (id, started_at, inserted, feeds_ok, feeds_fail) VALUES (?, ?, ?, ?, ?)"
  ).bind(uuid(), started, result.inserted, result.feeds_ok, result.feeds_fail).run();

  for (const group of chunk(perSource, DB_BATCH_SIZE)) {
    try {
      await env.DB.batch(
        group.map(({ source, stats }) =>
          env.DB.prepare(
            "INSERT OR REPLACE INTO ingestion_sources (run_started_at, source_id, source_name, status, http_status, parsed, recent, inserted, error) VALUES (?,?,?,?,?,?,?,?,?)"
          ).bind(started, source.id, stats.name, stats.status, stats.httpStatus, stats.parsed, stats.recent, stats.inserted, stats.error)
        )
      );
    } catch {
      // Observability table may be absent until migration 0014 is applied; the
      // articles themselves are already stored and must not be rolled back.
    }
  }
  result.sources = perSource.map((p) => p.stats);

  // Retention: keep two weeks of articles for the site's category pages.
  await env.DB.prepare("DELETE FROM articles WHERE fetched_at < ?")
    .bind(new Date(Date.now() - ARTICLE_RETENTION_DAYS * 24 * 3600 * 1000).toISOString())
    .run();
  if (damascusHour() === 4) {
    await env.DB.prepare("DELETE FROM rate_limits WHERE window < ?")
      .bind(new Date(Date.now() - 2 * 3600 * 1000).toISOString().slice(0, 13))
      .run();
  }

  return result;
}
