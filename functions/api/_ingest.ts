import { Env, nowISO, uuid, damascusHour, type Topic, VALID_TOPICS } from "./_lib";

interface FeedDef {
  topic: Topic;
  scope: "syria" | "global";
  url: string;
  /** تسمية المصدر حين لا ترسل التغذية اسمه لكل خبر */
  source?: string;
  /** topic forced by feed when keyword classification finds nothing */
  fallback?: boolean;
}

const GN = (q: string) =>
  `https://news.google.com/rss/search?q=${encodeURIComponent(q)}&hl=ar&gl=SY&ceid=SY:ar`;

export const FEEDS: FeedDef[] = [
  { topic: "politics", scope: "syria", url: GN("سوريا سياسة") },
  { topic: "economy", scope: "syria", url: GN("سوريا اقتصاد ليرة") },
  { topic: "economy", scope: "global", url: GN("أخبار اقتصادية عالمية") },
  { topic: "sports", scope: "syria", url: GN("سوريا رياضة") },
  { topic: "sports", scope: "global", url: GN("أخبار رياضية عالمية") },
  { topic: "tech", scope: "global", url: GN("تكنولوجيا ذكاء اصطناعي") },
  { topic: "health", scope: "global", url: GN("صحة طب علوم") },
  { topic: "culture", scope: "global", url: GN("ثقافة فنون") },
  { topic: "politics", scope: "global", url: GN("أخبار عالمية") },
  { topic: "politics", scope: "syria", url: "https://www.enabbaladi.org/feed/", source: "عنب بلدي" },
  { topic: "politics", scope: "syria", url: "https://sana.sy/feed/", source: "سانا", fallback: true },
  { topic: "politics", scope: "global", url: "https://feeds.bbci.co.uk/arabic/rss.xml", source: "BBC عربي", fallback: true },
  { topic: "politics", scope: "global", url: "https://www.france24.com/ar/rss", source: "France 24 عربية", fallback: true },
  { topic: "politics", scope: "global", url: "https://www.skynewsarabia.com/rss", source: "سكاي نيوز عربية", fallback: true },
];

const SYRIA_CITIES = [
  "دمشق", "حلب", "إدلب", "ادلب", "حماة", "حمص", "اللاذقية", "طرطوس",
  "درعا", "السويداء", "دير الزور", "ديرالزور", "الرقة", "عفرين",
  "قامشلو", "الحسكة", "القنيطرة", "الباب", "عزاز", "ريف حلب",
];

const SYRIA_WORDS = ["سوريا", "سوري", "سورية"];

const FOREIGN_MARKERS = [
  "إسرائيل", "اسرائيل", "لبنان", "تركيا", "تركي", "تركية", "الأردن", "الاردن", "العراق", "مصر",
  "أمريكا", "امريكا", "واشنطن", "أوروبا", "اوروبا", "روسيا", "موسكو", "إيران", "ايران", "طهران",
  "ميانمار", "غزة", "السعودية", "قطر", "الإمارات", "اليمن", "أوكرانيا", "ألمانيا", "كييف",
  "فرنسا", "باريس", "بريطانيا", "لندن", "الصين", "اليابان", "الهند", "باكستان", "قبرص", "جنيف",
  "الدنمارك", "السويد", "النرويج", "هولندا", "بلجيكا", "كندا", "أستراليا", "إيطاليا", "إسبانيا",
  "اليونان", "أثينا", "الناتو", "حلف شمال الأطلسي", "الأطلسي", "صندوق النقد", "البنتاغون", "البيت الأبيض", "الاتحاد الأوروبي",
  "إيطالي", "فرنسي", "ألماني", "بريطاني", "أمريكي", "أوروبي", "تركي", "روسي", "إيراني", "سعودي", "مصري", "عراقي", "لبناني",
];

/**
 * قاعدة التصنيف (بطلب المالك):
 * - الحدث داخل الجغرافيا السورية (مدينة/محافظة) => محلي
 * - خبر يذكر سوريا مع دولة أجنبية => عالمي (خبر سوري خارجي/دولي)
 * - خبر يذكر سوريا فقط => محلي (سياسة داخلية غالباً)
 * - غير ذلك => بحكم قناة التغذية
 */
function detectScope(title: string, feedScope: "syria" | "global"): "syria" | "global" {
  const hasCity = SYRIA_CITIES.some((c) => title.includes(c));
  const hasSyriaWord = SYRIA_WORDS.some((w) => title.includes(w));
  const hasForeign = FOREIGN_MARKERS.some((w) => title.includes(w));
  if (hasCity) return "syria";
  if (hasSyriaWord && hasForeign) return "global";
  if (hasSyriaWord) return "syria";
  if (hasForeign) return "global"; // فاعل أجنبي بلا أي ذكر لسوريا => عالمي حتى من قناة سورية
  return feedScope;
}

const KEYWORDS: { topic: Topic; words: string[] }[] = [
  { topic: "economy", words: ["اقتصاد", "ليرة", "نفط", "أسعار", "أسهم", "دولار", "تمويل", "تجارة", "تضخم", "بنك", "غاز", "استثمار"] },
  { topic: "tech", words: ["تكنولوجيا", "تقنية", "ذكاء اصطناعي", "روبوت", "تطبيق", "إنترنت", "فضاء", "سامسونج", "آبل", "مايكروسوفت", "شريحة", "حاسوب"] },
  { topic: "sports", words: ["رياضة", "كرة", "مباراة", "دوري", "منتخب", "أولمبياد", "بطولة", "تنس", "كرة السلة"] },
  { topic: "health", words: ["صحة", "طب", "وباء", "فيروس", "مستشفى", "دواء", "لقاح", "علماء", "علاج", "مرض"] },
  { topic: "culture", words: ["ثقافة", "فن", "سينما", "مسرح", "رواية", "معرض", "مهرجان", "فنان", "كتاب", "أدب", "موسيقى"] },
  { topic: "politics", words: ["سياسة", "حكومة", "وزير", "رئيس", "برلمان", "مجلس", "انتخاب", "اتفاق", "قمة", "مفاوضات", "حرب", "هدنة", "قرار أممي", "مجلس الأمن"] },
];

function classify(title: string): Topic | null {
  const t = title.toLowerCase();
  for (const k of KEYWORDS) {
    if (k.words.some((w) => t.includes(w))) return k.topic;
  }
  return null;
}

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

/** فكّ كيانات HTML بثلاث طبقات: المهرّبة مرتين (&&amp;nbsp;&&amp;) والرقمية (&#160;) والمسماة */
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
  // فكّ الكيانات أولاً ثم اخلع الوسوم: بعض المصادر تهرّب HTML داخل الوصف
  // فلا تصبح الوسوم قابلة للخلع إلا بعد فكّها — العكس القديم سرّب وسوم خام.
  v = unescape(v);
  return v.replace(/<[^>]*>/g, " ").replace(/\s+/g, " ").trim();
}

export function parseFeed(xml: string, maxItems = 12): RssItem[] {
  const items: RssItem[] = [];
  const blocks = xml.match(/<item>([\s\S]*?)<\/item>/g) || [];
  for (const b of blocks.slice(0, Math.min(40, Math.max(0, maxItems)))) {
    const title = pick(b, "title");
    const link = pick(b, "link");
    if (!title || !link || !/^https?:\/\//.test(link)) continue;
    items.push({
      title,
      link,
      pubDate: pick(b, "pubDate") || undefined,
      description: pick(b, "description") || undefined,
      source: pick(b, "source") || undefined,
      sourceUrl: unescape(b.match(/<source\s+[^>]*url=["']([^"']+)["']/i)?.[1] || "") || undefined,
    });
  }
  return items;
}

/** استخراج ملخص الخبر من صفحته الأصلية (og:description) حين لا ترسله التغذية */
async function fetchSummary(url: string): Promise<string | null> {
  try {
    const res = await fetch(url, {
      signal: AbortSignal.timeout(8000),
      redirect: "follow",
      headers: {
        "user-agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36",
        accept: "text/html,application/xhtml+xml",
      },
    });
    if (!res.ok) return null;
    const html = (await res.text()).slice(0, 80000);
    const m =
      html.match(/<meta[^>]+property=["']og:description["'][^>]*content=["']([^"']{40,420})["']/i) ||
      html.match(/<meta[^>]+content=["']([^"']{40,420})["'][^>]*property=["']og:description["']/i) ||
      html.match(/<meta[^>]+name=["']description["'][^>]*content=["']([^"']{40,420})["']/i) ||
      html.match(/<meta[^>]+content=["']([^"']{40,420})["'][^>]*name=["']description["']/i);
    if (!m) return null;
    const s = unescape(m[1]).replace(/<[^>]*>/g, " ").replace(/\s+/g, " ").trim();
    if (s.length < 40 || s.length > 400) return null;
    return s;
  } catch {
    return null;
  }
}

function cleanSummary(desc: string | undefined): string | null {
  if (!desc) return null;
  const s = desc.replace(/<[^>]*>/g, " ").replace(/\s+/g, " ").trim();
  if (s.length < 40 || s.length > 400) return null;
  if (/google news|view full coverage|مزيد من التغطية/i.test(s)) return null;
  return s;
}

export interface IngestionResult {
  ok: boolean;
  inserted: number;
  feeds_ok: number;
  feeds_fail: number;
  failed: string[];
}

export async function runIngestion(env: Env): Promise<IngestionResult> {
  const started = nowISO();
  let feeds_ok = 0;
  let feeds_fail = 0;
  let inserted = 0;
  let enriched = 0;
  const failed: string[] = [];

  for (const f of FEEDS) {
    try {
      const res = await fetch(f.url, {
        signal: AbortSignal.timeout(15000),
        headers: { "user-agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36" },
      });
      if (!res.ok) throw new Error("HTTP " + res.status);
      const xml = await res.text();
      const items = parseFeed(xml);
      if (!items.length) throw new Error("no items");
      feeds_ok++;

      const stmts: D1PreparedStatement[] = [];
      for (const it of items) {
        let title = it.title;
        let source = it.source || "";
        if (!source && title.includes(" - ")) {
          const parts = title.split(" - ");
          source = parts.pop()!.trim();
          title = parts.join(" - ").trim();
        }
        if (!source) source = f.source || "Google News";
        // عربية فقط (بطلب المالك): لا تُخزَّن أخبار عناوينها ليست عربية أصلاً
        const arabicChars = (title.match(/[\u0600-\u06FF]/g) || []).length;
        const latinChars = (title.match(/[A-Za-z]/g) || []).length;
        if (arabicChars < 5 || latinChars > arabicChars) continue;
        const topic = classify(title) ?? f.topic;
        if (!VALID_TOPICS.includes(topic)) continue;
        const scope: "syria" | "global" = detectScope(title, f.scope);
        const pub = it.pubDate ? new Date(it.pubDate) : null;
        const pubISO = pub && !isNaN(pub.getTime()) ? pub.toISOString() : null;
        let summary = cleanSummary(it.description);
        if (!summary && enriched < 12) {
          // عنوان بلا ملخص: افتح صفحة الخبر واستخرج وصفها الرسمي
          enriched++;
          summary = await fetchSummary(it.link);
        }
        stmts.push(
          env.DB.prepare(
            "INSERT OR IGNORE INTO articles (id, title, summary, url, source, topic, scope, published_at, fetched_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)"
          ).bind(uuid(), title, summary, it.link, source, topic, scope, pubISO, started)
        );
      }
      if (stmts.length) {
        const results = await env.DB.batch(stmts);
        for (const r of results) inserted += r.meta?.changes ?? 0;
      }
    } catch (e) {
      feeds_fail++;
      failed.push(f.url.slice(0, 60) + " :: " + (e instanceof Error ? e.message : "?"));
    }
  }

  // صيانة يومية واحدة (الساعة 4 بتوقيت دمشق) بدل حذف في كل جولة
  if (damascusHour() === 4) {
    await env.DB.prepare("DELETE FROM articles WHERE fetched_at < ?").bind(new Date(Date.now() - 7 * 24 * 3600 * 1000).toISOString()).run();
    await env.DB.prepare("DELETE FROM rate_limits WHERE window < ?").bind(new Date(Date.now() - 2 * 3600 * 1000).toISOString().slice(0, 13)).run();
  }
  await env.DB.prepare(
    "INSERT INTO ingestion_runs (id, started_at, inserted, feeds_ok, feeds_fail) VALUES (?, ?, ?, ?, ?)"
  ).bind(uuid(), started, inserted, feeds_ok, feeds_fail).run();

  return { ok: true, inserted, feeds_ok, feeds_fail, failed };
}
