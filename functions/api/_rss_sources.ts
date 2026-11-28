import type { Topic } from "./_lib";

/**
 * RSS source catalog for the simplified news MVP.
 *
 * Every entry below was probed live on 2026-11-26 (see docs/mvp/03_RSS_SOURCE_AUDIT.md).
 * `enabled: false` entries are kept for traceability and for a later retry; they are
 * never fetched by the ingestion engine.
 */
export interface RssSource {
  id: string;
  /** Display name stored with each article. */
  name: string;
  url: string;
  /** Geographic section used when title classification cannot decide. */
  scope: "syria" | "global";
  /** Topic used when title classification cannot decide. */
  topic: Topic;
  /** publisher = direct publisher feed; aggregator = intermediary index. */
  kind: "publisher" | "aggregator";
  enabled: boolean;
  /**
   * Per-feed parse cap. Defaults to MAX_ITEMS_PER_FEED (100). High-volume feeds
   * measured near or above 100 items/day may raise it up to MAX_ITEMS_HARD_CAP.
   */
  maxItems?: number;
  note?: string;
}

export const RSS_SOURCES: RssSource[] = [
  // ——— Syria (publisher feeds) ———
  {
    id: "sana",
    name: "سانا",
    url: "https://sana.sy/feed/",
    scope: "syria",
    topic: "politics",
    kind: "publisher",
    enabled: true,
    maxItems: 200,
    note: "State news agency. 150 fresh items on 2026-11-26. Measured 2026-11-27: the feed exposes 150 items covering ~21.5h, so the default 100 cap would drop the older ~10h of every day; the per-feed cap is raised to 200 to store everything the feed publishes. The feed itself truncates at 150 items, so coverage beyond that window is not guaranteed. Reachability is intermittent; a failed run is recorded and retried the next day.",
  },
  {
    id: "syria-tv",
    name: "تلفزيون سوريا",
    url: "https://www.syria.tv/rss",
    scope: "syria",
    topic: "politics",
    kind: "publisher",
    enabled: true,
    note: "125 fresh items on 2026-11-26; independent Syrian broadcaster. Measured 2026-11-27: 118 items spanning ~46h (~50-60/day), so the default 100 cap already covers more than 24h; no raised cap needed. HTTP 403 appears intermittently AT THE CLOUDFLARE EDGE (the 2026-11-27 staging ingest failed with it) while local probes from the dev machine returned 200 on 2026-11-28 across /rss, /rss.xml and /feed with 106 items — local success does NOT prove edge access. The failure is isolated and retried by the next run; no protection bypass is used.",
  },
  {
    id: "north-press",
    name: "وكالة نورث برس",
    url: "https://npasyria.com/feed/",
    scope: "syria",
    topic: "politics",
    kind: "publisher",
    enabled: true,
    note: "Kurdish-led Syrian news agency; 9 fresh items on 2026-11-26, north Syria coverage.",
  },

  // ——— Global Arabic (publisher feeds) ———
  {
    id: "bbc-arabic",
    name: "BBC عربي",
    url: "https://feeds.bbci.co.uk/arabic/rss.xml",
    scope: "global",
    topic: "politics",
    kind: "publisher",
    enabled: true,
    note: "25 items (20 fresh in 7 days) on 2026-11-26.",
  },
  {
    id: "france24-ar",
    name: "فرانس 24 عربية",
    url: "https://www.france24.com/ar/rss",
    scope: "global",
    topic: "politics",
    kind: "publisher",
    enabled: true,
    note: "24 fresh items on 2026-11-26.",
  },
  {
    id: "cnn-arabic",
    name: "CNN عربية",
    url: "https://arabic.cnn.com/api/v1/rss/rss.xml",
    scope: "global",
    topic: "politics",
    kind: "publisher",
    enabled: true,
    note: "20 fresh items on 2026-11-26.",
  },
  {
    id: "aljazeera-net",
    name: "الجزيرة نت",
    url: "https://www.aljazeera.net/aljazeerarss/a7c186be-1baa-4bd4-9d80-a84db769f779/73d0e1b4-532f-45ef-b135-bfdff8b8cab9",
    scope: "global",
    topic: "politics",
    kind: "publisher",
    enabled: true,
    note: "25 fresh items on 2026-11-26.",
  },

  // ——— Rejected or paused candidates ———
  {
    id: "enab-baladi",
    name: "عنب بلدي",
    url: "https://www.enabbaladi.org/feed/",
    scope: "syria",
    topic: "politics",
    kind: "publisher",
    enabled: false,
    note: "RSS reachable but stale: newest item 2019-03-10 (the .com feed's newest is 2025-08-06). No current news; excluded until the feed resumes.",
  },
  {
    id: "athr-press",
    name: "أثر برس",
    url: "https://athrpress.com/feed/",
    scope: "syria",
    topic: "politics",
    kind: "publisher",
    enabled: false,
    note: "RSS reachable but stale: newest item 2025-11-06; no fresh coverage.",
  },
  {
    id: "skynewsarabia",
    name: "سكاي نيوز عربية",
    url: "https://www.skynewsarabia.com/rss",
    scope: "global",
    topic: "politics",
    kind: "publisher",
    enabled: false,
    note: "HTTP 403 for a non-browser client on 2026-11-26.",
  },
  {
    id: "alarabiya",
    name: "العربية",
    url: "https://www.alarabiya.net/rss",
    scope: "global",
    topic: "politics",
    kind: "publisher",
    enabled: false,
    note: "HTTP 403 on 2026-11-26.",
  },
  {
    id: "aitnews",
    name: "البوابة العربية للأخبار التقنية",
    url: "https://www.aitnews.com/feed/",
    scope: "global",
    topic: "tech",
    kind: "publisher",
    enabled: false,
    note: "Cloudflare bot challenge returned an HTML interstitial instead of RSS.",
  },
  {
    id: "dw-arabic",
    name: "DW عربية",
    url: "https://rss.dw.com/rdf/rss-ar-all",
    scope: "global",
    topic: "politics",
    kind: "publisher",
    enabled: false,
    note: "RSS 1.0 (RDF) items carry attributes; the current parser extracts zero items. Revisit only with an RDF parser.",
  },
];

/** Enabled sources in catalog order. */
export const enabledSources = (): RssSource[] => RSS_SOURCES.filter((s) => s.enabled);

/** Persistence lookback: keep the last three days of feed items, one daily run. */
export const INGEST_LOOKBACK_HOURS = 72;
/** Retention for stored articles shown on the site. */
export const ARTICLE_RETENTION_DAYS = 14;
/** Maximum items parsed per feed per run (default; protects memory and D1 writes). */
export const MAX_ITEMS_PER_FEED = 100;
/** Absolute ceiling for a single feed's raised cap (see per-source `maxItems`). */
export const MAX_ITEMS_HARD_CAP = 200;
