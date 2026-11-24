import { parseFeed } from "./_ingest";
import { inspectPublisher, type Provenance } from './_publisher';
import { lookupPublisherFeed } from './_secondary';
export { lookupPublisherFeed } from './_secondary';
export { inspectPublisher } from './_publisher';

// D1's prepare/bind/first/all/run contract; kept small so it can also be tested locally.
export interface Database {
  prepare(sql: string): { bind(...args: unknown[]): { first<T>(): Promise<T | null>; all<T>(): Promise<{ results: T[] }>; run(): Promise<{ meta: { changes: number } }> } };
}
export interface Candidate { title: string; url: string; source: string; sourceUrl?: string; description: string; publishedAt: string | null; provider: string }
export interface Decision extends Candidate, Provenance { accepted: boolean; reason: string; score: number; duplicate?: boolean; sourceResolved: boolean; publisherTitleMatch: boolean | null; publisherDateDifferenceHours: number | null }
type Fetch = typeof fetch;
const cities = ["دمشق", "حلب", "إدلب", "حمص", "حماة", "اللاذقية", "طرطوس", "درعا", "السويداء", "الرقة", "الحسكة", "دير الزور", "القنيطرة"];
const synonyms = [["بناء", "تراخيص", "ترخيص", "عمران", "عقارات", "تنظيم"], ["كهرباء", "تيار"], ["مياه", "ماء", "شرب"], ["سيارات", "سيارة", "مركبات", "مركبة"], ["استيراد", "استيرادها", "جمرك"], ["قوانين", "قانون", "قرارات", "قرار", "تعميم"], ["مؤتمر", "مؤتمرات"], ["أشعة", "شعاعي", "شعاعية"]];
const stop = new Set(["في", "من", "الي", "عن", "علي", "مع", "سوريا", "سوريه", "جديده", "جديد", "تحديثات", "متعلقه", "خدمات"]);
const subregions: Record<string,string[]> = {"إدلب":["معرة النعمان", "أريحا", "جسر الشغور", "سراقب"], "حلب":["عفرين", "الباب", "منبج", "أعزاز"], "دمشق":["دمشق"]};
export function normalize(s: string): string { return s.toLowerCase().replace(/[\u064b-\u065f\u0670ـ]/g, "").replace(/[أإآٱ]/g,"ا").replace(/ى/g,"ي").replace(/ة/g,"ه").replace(/[^\p{L}\p{N}]+/gu," ").trim().replace(/\s+/g," "); }
function words(s: string): string[] { return normalize(s).split(" ").map(w => w.startsWith("ال") && w.length > 4 ? w.slice(2) : w).filter(w => w.length > 2 && !stop.has(w)); }
function group(word: string): string[] { return synonyms.map(g => g.map(normalize)).find(g => g.some(x => x === word || (word.length > 4 && (x.includes(word) || word.includes(x))))) || [word]; }
function cityOf(s: string): string | undefined { return cities.find(c => normalize(s).includes(normalize(c))); }
export function generateQueries(interest: string, monitoredHosts: string[] = []): string[] {
  const place = cityOf(interest) || "سوريا";
  const original = interest.trim().replace(/\s+/g," ");
  const expansions = words(interest).filter(w => normalize(place) !== w).map(w => group(w).find(x => x !== w) || w);
  // Reserved .test domains come from deterministic mock discovery and must never reach live queries.
  const liveHosts = monitoredHosts.filter(h => !/(?:^|\.)test$/i.test(h));
  const candidates = [original, `${expansions.join(" ")} ${place}`, `${original} قرارات تحديثات`, ...liveHosts.slice(0, 1).map(h => `${original} site:${h}`)];
  return [...new Set(candidates.map(x => x.trim()).filter(Boolean))].slice(0, 4);
}
function canonical(url: string): string | null { try { const u = new URL(url); if (!['http:','https:'].includes(u.protocol) || u.username || u.password) return null; u.hash = ''; for (const key of [...u.searchParams.keys()]) if (/^(utm_|fbclid|gclid)/i.test(key)) u.searchParams.delete(key); u.hostname = u.hostname.toLowerCase(); return u.toString(); } catch { return null; } }
export function evaluate(interest: string, c: Candidate, now = Date.now()): Decision {
  const locations = cities.filter(city => normalize(interest).includes(normalize(city))); const text = normalize(`${c.title} ${c.description}`);
  const missingLocations = locations.filter(loc => ![loc, ...(subregions[loc] || [])].some(x => text.includes(normalize(x))));
  const terms = words(interest).filter(w => !cities.some(city => normalize(city) === w));
  const uniqueGroups = [...new Set(terms.map(w => group(w).join('|')))];
  const matches = uniqueGroups.filter(g => g.split('|').some(w => text.includes(w)));
  const score = uniqueGroups.length ? matches.length / uniqueGroups.length : 0;
  const url = canonical(c.url); const host = url ? new URL(url).hostname : '';
  const sourceResolved = !!host && host !== 'news.google.com';
  let reason = `matched ${matches.length}/${uniqueGroups.length} topic groups`;
  let accepted = !!url && matches.length >= 1 && score >= 0.34;
  if (!url) { accepted = false; reason = 'invalid URL'; }
  else if (missingLocations.length) { accepted = false; reason = `location ${missingLocations.join(', ')} absent`; }
  else if (c.publishedAt && now - new Date(c.publishedAt).getTime() > 30*86400000) { accepted = false; reason = 'older than 30 days'; }
  else if (!accepted) reason = 'insufficient topic overlap';
  if (accepted && !c.publishedAt) reason += '; publication date unavailable';
  if (accepted && !sourceResolved) reason += '; original URL unresolved';
  return { ...c, url: url || c.url, accepted, reason, score, sourceResolved, googleNewsUrl: host === 'news.google.com' ? c.url : null, originalUrl: sourceResolved ? url : null, resolutionStatus: sourceResolved ? 'direct_provider_url' : 'not_attempted', publisherTitle: null, publisherPublishedAt: null, publisherText:null, verificationStatus: 'not_attempted', publisherTitleMatch: null, publisherDateDifferenceHours: null };
}
export function comparePublisher(d: Decision): void {
  if (d.publisherTitle) {
    const searchTokens = new Set(words(d.title.split(' - ')[0])); const publisherTokens = new Set(words(d.publisherTitle));
    const matched = [...searchTokens].filter(w => publisherTokens.has(w)).length;
    d.publisherTitleMatch = searchTokens.size > 0 && matched / searchTokens.size >= 0.6;
    d.verificationStatus += d.publisherTitleMatch ? '; title_match' : '; title_mismatch';
  }
  if (d.publishedAt && d.publisherPublishedAt) {
    d.publisherDateDifferenceHours = Math.abs(Date.parse(d.publishedAt) - Date.parse(d.publisherPublishedAt)) / 3600000;
    d.verificationStatus += d.publisherDateDifferenceHours > 48 ? '; date_mismatch' : '; dates_consistent_48h';
  }
}
function date(value: unknown): string | null { if (typeof value !== 'string') return null; const d = new Date(value); return Number.isFinite(d.getTime()) && d.getTime() <= Date.now()+86400000 ? d.toISOString() : null; }
async function request(fetcher: Fetch, url: string, headers: Record<string,string> = {}): Promise<Response> {
  let error: unknown;
  for (let attempt=0; attempt<2; attempt++) {
    try { const r = await fetcher(url, {headers, signal: AbortSignal.timeout(10000)}); if (r.ok) return r;
      if (r.status === 429) { const raw=r.headers.get('retry-after'); const numeric=raw && /^\d+$/.test(raw) ? Number(raw) : NaN; const asDate=raw ? Date.parse(raw) : NaN; const seconds=Number.isFinite(numeric) ? numeric : Number.isFinite(asDate) ? Math.max(0,Math.ceil((asDate-Date.now())/1000)) : 0; throw new Error(`HTTP 429; retry later${seconds>0 ? ` (Retry-After ${seconds}s)` : ''}`); }
      if (r.status < 500) throw new Error(`HTTP ${r.status}`);
      error = new Error(`HTTP ${r.status}`);
    } catch (e) { if (String(e).includes('HTTP 429') || /HTTP 4\d\d/.test(String(e))) throw e; error = e; }
    if (attempt===0) await new Promise(resolve => setTimeout(resolve,250));
  }
  throw error;
}
export async function search(query: string, key: string | undefined, fetcher: Fetch = fetch): Promise<{items: Candidate[]; provider: string; warning?: string}> {
  let warning: string | undefined;
  if (key) {
    try { const params = new URLSearchParams({q:query, count:'10', freshness:'pm', search_lang:'ar'}); const r = await request(fetcher, `https://api.search.brave.com/res/v1/web/search?${params}`, {'X-Subscription-Token':key, Accept:'application/json'}); const data = await r.json() as {web?:{results?:Array<{title?:string;url?:string;description?:string;page_age?:string; profile?:{name?:string}}>}};
      return {provider:'brave', items:(data.web?.results || []).filter(x=>x.title && x.url).map(x=>({title:x.title!,url:x.url!,source:x.profile?.name || '',description:x.description || '',publishedAt:null,provider:'brave'}))};
    } catch (e) { warning = `Brave failed; RSS fallback: ${String(e)}`; }
  } else warning = 'No Brave key: Google News RSS coverage is limited to indexed news.';
  const q = new URLSearchParams({q:`${query} when:30d`,hl:'ar',gl:'SY',ceid:'SY:ar'});
  const r = await request(fetcher, `https://news.google.com/rss/search?${q}`);
  return { provider:'google-news-rss', warning, items:parseFeed(await r.text()).map(x=>({title:x.title,url:x.link,source:x.source || '',sourceUrl:x.sourceUrl,description:x.description || '',publishedAt:date(x.pubDate),provider:'google-news-rss'})) };
}

// Deterministic mock provider: credential-free sample data for integration runs.
// Clearly separated from live providers: items carry provider 'mock', the run
// report is marked mock, and no network I/O is performed.
const MOCK_SOURCE = 'https://mock-source.test';
const MOCK_ITEMS: Candidate[] = [
  { title:'قرار ترخيص البناء في إدلب', url:MOCK_SOURCE+'/news/idlib-building-licence', source:'مصدر تجريبي', sourceUrl:MOCK_SOURCE, description:'ضوابط جديدة لتراخيص البناء في محافظة إدلب', publishedAt:null, provider:'mock' },
  { title:'قرار ترخيص البناء في حلب', url:MOCK_SOURCE+'/news/aleppo-building-licence', source:'مصدر تجريبي', sourceUrl:MOCK_SOURCE, description:'ضوابط جديدة لتراخيص البناء في محافظة حلب', publishedAt:null, provider:'mock' },
];
async function mockSearch(): Promise<{items:Candidate[]; provider:string; warning?:string}> {
  return { provider:'mock', items:MOCK_ITEMS.map(x=>({...x})) };
}
const mockFetch: Fetch = async (input) => {
  const u = new URL(String(input));
  if (u.hostname !== 'mock-source.test') return new Response(null,{status:404});
  if (u.pathname === '/robots.txt') return new Response(null,{status:404});
  const item = MOCK_ITEMS.find(x => x.url === u.origin + u.pathname) || MOCK_ITEMS[0];
  const title = item.title.replace(/"/g,'&quot;');
  return new Response(`<!doctype html><html><head><meta property="og:title" content="${title}"><meta property="article:published_time" content="2026-11-20T10:00:00Z"></head><body><article>${title} — نص تجريبي ثابت للتحقق من حفظ المصدر.</article></body></html>`,{status:200,headers:{'content-type':'text/html'}});
};
export async function runDiscovery(db: Database, interest: string, opts: {key?:string; fetcher?:Fetch; mock?:boolean} = {}) {
  interest = interest.trim(); if (interest.length < 3 || interest.length > 300) throw new Error('Interest must be between 3 and 300 characters');
  const interestKey = normalize(interest); const started = new Date().toISOString(); const runId = crypto.randomUUID();
  const hosts = await db.prepare('SELECT host FROM discovery_source_interests WHERE interest_key = ? LIMIT 1').bind(interestKey).all<{host:string}>();
  const queries = generateQueries(interest, hosts.results.map(x=>x.host));
  await db.prepare('INSERT INTO discovery_runs (id, interest, started_at) VALUES (?, ?, ?)').bind(runId, interest, started).run();
  const decisions: Decision[] = []; const errors: string[] = []; const warnings = new Set<string>(); let duplicates = 0;
  const inspected = new Map<string,Provenance>();
  const fetcher = opts.mock ? mockFetch : opts.fetcher;
  if (opts.mock) warnings.add('Mock discovery: deterministic sample data; results are not live search output.');
  else if (!opts.key) warnings.add('No Brave key: Google News RSS coverage is limited to indexed news.');
  for (const query of queries) {
    try { const result = opts.mock ? await mockSearch() : await search(query,opts.key,opts.fetcher); if (result.warning) warnings.add(result.warning);
      for (const item of result.items) { const d = evaluate(interest,item); decisions.push(d); if (!d.accepted) continue;
        if (!inspected.has(d.url) && inspected.size < 8) {
          let provenance=await inspectPublisher(d.url,d.sourceUrl,fetcher);
          if (!provenance.originalUrl && provenance.googleNewsUrl && d.sourceUrl) {
            const secondary=await lookupPublisherFeed(d.title,d.source,d.sourceUrl,provenance.googleNewsUrl,d.publishedAt,fetcher);
            if (secondary) provenance=secondary;
            else provenance.resolutionStatus += '; publisher_feed_no_verified_match';
          }
          inspected.set(d.url,provenance);
        }
        if (inspected.has(d.url)) { Object.assign(d,inspected.get(d.url)); d.sourceResolved = !!d.originalUrl; if (d.sourceResolved) d.reason = d.reason.replace('; original URL unresolved',''); comparePublisher(d); }
        else d.resolutionStatus = 'inspection_budget_exhausted';
        const id = crypto.randomUUID(); const titleKey = normalize(d.title); const sourceUrl = canonical(d.sourceUrl || ''); const sourceHost = sourceUrl ? new URL(sourceUrl).hostname : null;
        const host = d.originalUrl ? new URL(d.originalUrl).hostname : sourceHost && sourceHost !== 'news.google.com' ? sourceHost : null;
        const insert = await db.prepare('INSERT OR IGNORE INTO discovery_items (id,url,title_key,title,description,source,published_at,discovered_at,source_host,is_mock) VALUES (?,?,?,?,?,?,?,?,?,?)').bind(id,d.url,titleKey,d.title,d.description,d.source,d.publishedAt,started,host,opts.mock ? 1 : 0).run();
        const existing = insert.meta.changes ? {id} : await db.prepare('SELECT id FROM discovery_items WHERE url = ? OR title_key = ? LIMIT 1').bind(d.url,titleKey).first<{id:string}>();
        if (!insert.meta.changes) { d.duplicate = true; duplicates++; d.reason += '; duplicate'; }
        if (existing) await db.prepare("UPDATE discovery_items SET google_news_url=COALESCE(?,google_news_url), original_url=COALESCE(?,original_url), resolution_status=CASE WHEN ? IS NULL AND original_url IS NOT NULL THEN resolution_status ELSE ? END, publisher_title=COALESCE(?,publisher_title), publisher_published_at=COALESCE(?,publisher_published_at), verification_status=CASE WHEN ? IS NULL AND publisher_title IS NOT NULL THEN verification_status ELSE ? END WHERE id=?").bind(d.googleNewsUrl,d.originalUrl,d.originalUrl,d.resolutionStatus,d.publisherTitle,d.publisherPublishedAt,d.publisherTitle,d.verificationStatus,existing.id).run();
        if (existing) await db.prepare('INSERT OR IGNORE INTO discovery_item_interests (interest_key,item_id,score) VALUES (?,?,?)').bind(interestKey,existing.id,d.score).run();
        if (host) { await db.prepare('INSERT INTO discovery_sources (host,name,first_seen,last_seen) VALUES (?,?,?,?) ON CONFLICT(host) DO UPDATE SET last_seen=excluded.last_seen').bind(host,d.source || host,started,started).run(); await db.prepare('INSERT OR IGNORE INTO discovery_source_interests (interest_key,host) VALUES (?,?)').bind(interestKey,host).run(); }
      }
    } catch (e) { const cause = e instanceof Error ? e.cause : undefined; errors.push(`${query}: ${String(e)}${cause ? `; cause: ${String(cause)}` : ''}`); if (String(e).includes('HTTP 429')) break; }
  }
  const report = {runId, interest, started, queries, decisions, duplicates, errors, warnings:[...warnings], incomplete:errors.length>0, mock: opts.mock === true};
  await db.prepare('UPDATE discovery_runs SET finished_at=?, report=? WHERE id=?').bind(new Date().toISOString(),JSON.stringify(report),runId).run();
  return report;
}
