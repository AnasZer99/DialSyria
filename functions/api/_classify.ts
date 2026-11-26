import type { Topic } from "./_lib";

/**
 * Deterministic classification and URL normalisation shared by ingestion and tests.
 * Classification prefers the feed's declared topic only when the title carries no
 * usable keyword evidence; it never invents a category for an empty title.
 */

const SYRIA_CITIES = [
  "دمشق", "حلب", "إدلب", "ادلب", "حماة", "حمص", "اللاذقية", "طرطوس",
  "درعا", "السويداء", "دير الزور", "ديرالزور", "الرقة", "عفرين",
  "قامشلو", "الحسكة", "القنيطرة", "الباب", "عزاز", "ريف حلب", "منبج", "تل أبيض",
];

const SYRIA_WORDS = ["سوريا", "سوري", "سورية", "السورية"];

const FOREIGN_MARKERS = [
  "إسرائيل", "اسرائيل", "لبنان", "تركيا", "تركي", "تركية", "الأردن", "الاردن", "العراق", "مصر",
  "أمريكا", "امريكا", "واشنطن", "أوروبا", "اوروبا", "روسيا", "موسكو", "إيران", "ايران", "طهران",
  "ميانمار", "غزة", "السعودية", "قطر", "الإمارات", "اليمن", "أوكرانيا", "ألمانيا", "كييف",
  "فرنسا", "باريس", "بريطانيا", "لندن", "الصين", "اليابان", "الهند", "باكستان", "قبرص", "جنيف",
  "الدنمارك", "السويد", "النرويج", "هولندا", "بلجيكا", "كندا", "أستراليا", "إيطاليا", "إسبانيا",
  "اليونان", "أثينا", "الناتو", "حلف شمال الأطلسي", "الأطلسي", "صندوق النقد", "البنتاغون", "البيت الأبيض", "الاتحاد الأوروبي",
  "إيطالي", "فرنسي", "ألماني", "بريطاني", "أمريكي", "أوروبي", "تركي", "روسي", "إيراني", "سعودي", "مصري", "عراقي", "لبناني",
];

const KEYWORDS: { topic: Topic; words: string[] }[] = [
  { topic: "economy", words: ["اقتصاد", "اقتصادي", "ليرة", "نفط", "أسعار", "أسهم", "دولار", "تمويل", "تجارة", "تضخم", "بنك", "غاز", "استثمار", "ميزانية", "صادرات", "واردات", "رواتب", "أسواق"] },
  { topic: "tech", words: ["تكنولوجيا", "تقنية", "ذكاء اصطناعي", "روبوت", "تطبيق", "إنترنت", "فضاء", "سامسونج", "آبل", "مايكروسوفت", "شريحة", "حاسوب", "هاتف", "برمجة", "أمن سيبراني", "بيانات"] },
  { topic: "sports", words: ["رياضة", "رياضي", "كرة", "مباراة", "دوري", "منتخب", "أولمبياد", "بطولة", "تنس", "كرة السلة", "هدف", "لاعب", "ملعب", "تدريب"] },
  { topic: "health", words: ["صحة", "صحي", "طب", "طبي", "وباء", "فيروس", "مستشفى", "دواء", "لقاح", "علاج", "مرض", "أطباء", "جراحة", "سرطان", "سكري"] },
  { topic: "culture", words: ["ثقافة", "ثقافي", "فن", "فني", "سينما", "مسرح", "رواية", "معرض", "مهرجان", "فنان", "كتاب", "أدب", "موسيقى", "تراث", "شعر", "لوحة"] },
  { topic: "politics", words: ["سياسة", "سياسي", "حكومة", "وزير", "رئيس", "برلمان", "مجلس", "انتخاب", "اتفاق", "قمة", "مفاوضات", "حرب", "هدنة", "قرار أممي", "مجلس الأمن", "دبلوماسي", "سفير", "معارضة", "جماعات", "عقوبات"] },
];

export function detectScope(title: string, feedScope: "syria" | "global"): "syria" | "global" {
  const hasCity = SYRIA_CITIES.some((c) => title.includes(c));
  const hasSyriaWord = SYRIA_WORDS.some((w) => title.includes(w));
  const hasForeign = FOREIGN_MARKERS.some((w) => title.includes(w));
  if (hasCity) return "syria";
  if (hasSyriaWord && hasForeign) return "global"; // سوري + فاعل أجنبي: خبر دولي
  if (hasSyriaWord) return "syria";
  if (hasForeign) return "global"; // فاعل أجنبي بلا سوريا: عالمي حتى من قناة سورية
  return feedScope;
}

/** Highest keyword score wins; ties fall back to catalog priority order. */
export function classifyTopic(title: string): Topic | null {
  const t = title.toLowerCase();
  let best: { topic: Topic; score: number } | null = null;
  for (const group of KEYWORDS) {
    let score = 0;
    for (const w of group.words) if (t.includes(w)) score++;
    if (score > 0 && (!best || score > best.score)) best = { topic: group.topic, score };
  }
  return best ? best.topic : null;
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

export { SYRIA_CITIES, FOREIGN_MARKERS, KEYWORDS };
