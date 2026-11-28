import type { Topic } from "./_lib";

/**
 * Deterministic classification and URL normalisation shared by ingestion and tests.
 *
 * Rules (2026-11-28 revision):
 * - `classifyTopic` returns null when no keyword evidence exists; the ingestion
 *   engine EXCLUDES such items instead of defaulting them to `politics`.
 * - `detectScope` no longer flips a story to `global` merely because a Syrian
 *   title mentions a foreign country: a Syrian city or Syria word keeps it
 *   `syria`; foreign geography alone makes it `global`; otherwise the feed's
 *   declared scope is the last resort.
 * - Geography matching runs on a lightly normalised title (hamza/alef unified,
 *   diacritics and tatweel removed) with Arabic word boundaries that tolerate
 *   the definite article, so partial matches like «البابا» (الباب) or
 *   «الرياضي» (الرياض) cannot misfire.
 */

/** Light Arabic normalisation: strip diacritics/tatweel, unify alef and yeh forms. */
function loose(text: string): string {
  return text
    .replace(/[\u064B-\u065F\u0670]/g, "")
    .replace(/\u0640/g, "")
    .replace(/[أإآٱ]/g, "ا")
    .replace(/ى/g, "ي");
}

/** Whole-word geography hit that tolerates the definite article prefix («ال»). */
function geoHit(text: string, rawWord: string): boolean {
  const word = loose(rawWord);
  const pattern = `(?<![\\u0600-\\u06FF])(?:ال)?${word}(?![\\u0600-\\u06FF])`;
  return new RegExp(pattern).test(text);
}

const SYRIA_CITIES = [
  "دمشق", "حلب", "إدلب", "ادلب", "حماة", "حمص", "اللاذقية", "طرطوس",
  "درعا", "السويداء", "دير الزور", "ديرالزور", "الرقة", "عفرين",
  "قامشلو", "الحسكة", "القنيطرة", "الباب", "عزاز", "ريف حلب", "منبج", "تل أبيض",
];

const SYRIA_WORDS = ["سوريا", "سوري", "سورية", "السورية"];

const FOREIGN_MARKERS = [
  "إسرائيل", "اسرائيل", "لبنان", "بيروت", "تركيا", "أنقرة", "الأردن", "الاردن", "عمان", "العراق", "بغداد", "أربيل", "مصر",
  "أمريكا", "امريكا", "واشنطن", "نيويورك", "أوروبا", "اوروبا", "روسيا", "موسكو", "كييف", "إيران", "ايران", "طهران",
  "ميانمار", "غزة", "السعودية", "الرياض", "قطر", "الدوحة", "الإمارات", "أبوظبي", "اليمن", "أوكرانيا", "ألمانيا",
  "فرنسا", "باريس", "بريطانيا", "لندن", "الصين", "بكين", "اليابان", "الهند", "باكستان", "قبرص", "جنيف",
  "الدنمارك", "السويد", "النرويج", "هولندا", "بلجيكا", "كندا", "أستراليا", "إيطاليا", "إسبانيا",
  "اليونان", "أثينا", "الناتو", "حلف شمال الأطلسي", "الأطلسي", "صندوق النقد", "البنتاغون", "البيت الأبيض", "الاتحاد الأوروبي",
  "صنعاء", "الخرطوم", "طرابلس", "تونس", "الجزائر", "المغرب", "الفاتيكان",
];

const FOREIGN_NATIONALITIES = [
  "إسرائيلي", "اسرائيلي", "تركي", "تركية", "عراقي", "مصري", "أمريكي", "امريكي", "روسي", "إيراني", "ايراني",
  "سعودي", "لبناني", "ألماني", "بريطاني", "فرنسي", "إيطالي", "أوروبي", "صيني", "هندي", "يمني",
];

const KEYWORDS: { topic: Topic; words: string[] }[] = [
  { topic: "economy", words: ["اقتصاد", "اقتصادي", "ليرة", "نفط", "أسعار", "أسهم", "دولار", "دولارات", "تمويل", "تجارة", "تجاري", "تضخم", "بنك", "غاز", "استثمار", "ميزانية", "صادرات", "واردات", "رواتب", "أسواق", "بورصة", "رأس المال", "جمركي", "جمركية", "رسوم", "أرباح", "خسائر"] },
  { topic: "tech", words: ["تكنولوجيا", "تقنية", "ذكاء اصطناعي", "روبوت", "تطبيق", "إنترنت", "فضاء", "سامسونج", "آبل", "مايكروسوفت", "شريحة", "حاسوب", "هاتف", "برمجة", "أمن سيبراني", "بيانات"] },
  { topic: "sports", words: ["رياضة", "رياضي", "كرة", "مباراة", "دوري", "منتخب", "أولمبياد", "بطولة", "تنس", "كرة السلة", "هدف", "لاعب", "ملعب", "تدريب", "فروسية", "سباق"] },
  { topic: "health", words: ["صحة", "صحي", "طب", "طبي", "وباء", "فيروس", "مستشفى", "دواء", "لقاح", "علاج", "مرض", "أطباء", "جراحة", "سرطان", "سكري", "تلقيح", "تطعيم", "إنفلونزا", "انفلونزا"] },
  { topic: "culture", words: ["ثقافة", "ثقافي", "فن", "فني", "سينما", "مسرح", "رواية", "معرض", "مهرجان", "فنان", "كتاب", "أدب", "موسيقى", "تراث", "شعر", "لوحة", "فيلم", "أفلام"] },
  { topic: "politics", words: ["سياسة", "سياسي", "حكومة", "حكومي", "وزير", "رئيس", "برلمان", "مجلس", "انتخاب", "اتفاق", "قمة", "مفاوضات", "حرب", "هدنة", "قرار أممي", "مجلس الأمن", "دبلوماسي", "سفير", "معارضة", "جماعات", "عقوبات", "دستور", "دستورية", "تهم", "اتهام", "اتهامات", "صاروخ", "صواريخ", "ميليشيا", "جيش", "عسكري", "مظاهرة", "احتجاج"] },
];

const NORMALIZED_KEYWORDS = KEYWORDS.map((group) => ({ ...group, words: group.words.map(loose) }));

export function detectScope(title: string, feedScope: "syria" | "global"): "syria" | "global" {
  const text = loose(title);
  const hasCity = SYRIA_CITIES.some((c) => geoHit(text, c));
  const hasSyriaWord = SYRIA_WORDS.some((w) => text.includes(w));
  const hasForeign =
    FOREIGN_MARKERS.some((w) => geoHit(text, w)) ||
    FOREIGN_NATIONALITIES.some((w) => geoHit(text, w));
  if (hasCity) return "syria"; // a Syrian locality beats foreign markers
  if (hasSyriaWord) return "syria"; // a Syrian story mentioning a foreign country stays local
  if (hasForeign) return "global"; // foreign geography from a Syrian feed is still world news
  return feedScope; // last resort: the feed's declared section
}

/** Highest keyword score wins; ties fall back to catalog priority order. */
export function classifyTopic(title: string): Topic | null {
  const t = loose(title.toLowerCase());
  let best: { topic: Topic; score: number } | null = null;
  for (const group of NORMALIZED_KEYWORDS) {
    let score = 0;
    for (const w of group.words) if (topicHit(t, w)) score++;
    if (score > 0 && (!best || score > best.score)) best = { topic: group.topic, score };
  }
  return best ? best.topic : null;
}

/**
 * Short keywords (e.g. «طب») must not substring-match inside unrelated words
 * («تطبيق»); they use whole-word matching with the definite-article tolerance.
 */
function topicHit(t: string, word: string): boolean {
  if (word.length <= 2) return geoHit(t, word);
  return t.includes(word);
}

/** Remove tracking parameters, hashes and a trailing slash; reject non-http(s). */
export function canonicalUrl(raw: string): string | null {
  try {
    const u = new URL(raw);
    if (!["http:", "https:"].includes(u.protocol)) return null;
    if (u.username || u.password) return null;
    u.hash = "";
    for (const key of [...u.searchParams.keys()]) {
      if (/^(utm_|fbclid|gclid|igshid|mc_cid|mc_eid)/i.test(key)) u.searchParams.delete(key);
    }
    if (u.pathname.length > 1) u.pathname = u.pathname.replace(/\/+$/, "");
    return u.toString();
  } catch {
    return null;
  }
}

export { SYRIA_CITIES, FOREIGN_MARKERS, FOREIGN_NATIONALITIES, KEYWORDS };
