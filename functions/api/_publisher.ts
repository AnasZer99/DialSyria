import { isLiveBudgetError } from './_live_budget';
export interface Provenance { googleNewsUrl: string | null; originalUrl: string | null; resolutionStatus: string; publisherTitle: string | null; publisherPublishedAt: string | null; publisherText: string | null; verificationStatus: string; retryAfterSeconds?: number }
type Fetcher = typeof fetch;
export function safeUrl(value: string): URL | null {
  try {
    const u = new URL(value); const h = u.hostname.toLowerCase();
    if (!['http:', 'https:'].includes(u.protocol) || u.username || u.password || u.port || !h.includes('.') || /(^|\.)(localhost|local|internal|home|lan)$/.test(h) || /^[\d.]+$/.test(h) || h.includes(':')) return null;
    return u;
  } catch { return null; }
}
function sameHost(a: string, b: string): boolean { return a.toLowerCase().replace(/^www\./,'') === b.toLowerCase().replace(/^www\./,''); }
export function allowedByRobots(robots: string, pathname: string): boolean {
  const groups: Array<{agents:string[]; rules:Array<{key:string; value:string}>}> = [];
  let current: {agents:string[]; rules:Array<{key:string; value:string}>} | null = null;
  for (const line of robots.split(/\r?\n/)) {
    const s = line.replace(/#.*$/, '').trim(); if (!s) continue;
    const m = s.match(/^([^:]+):\s*(.*)$/); if (!m) continue;
    const key = m[1].trim().toLowerCase(), value = m[2].trim();
    if (key === 'user-agent') { if (!current || current.rules.length) { current={agents:[],rules:[]}; groups.push(current); } current.agents.push(value.toLowerCase()); }
    else if ((key === 'allow' || key === 'disallow') && current) current.rules.push({key,value});
  }
  const specific = groups.filter(g => g.agents.some(a => a !== '*' && 'dialsyria-discovery'.includes(a)));
  const selected = specific.length ? specific : groups.filter(g => g.agents.includes('*'));
  let best = -1; let allowed = true;
  for (const g of selected) for (const {key,value} of g.rules) {
    if (!value) continue;
    // Unsupported wildcard syntax fails closed.
    if (value.includes('*') || value.includes('$')) return false;
    if (pathname.startsWith(value) && (value.length > best || (value.length === best && key === 'allow'))) { best = value.length; allowed = key === 'allow'; }
  }
  return allowed;
}
function attrs(tag: string): Record<string,string> { const out: Record<string,string> = {}; for (const m of tag.matchAll(/([\w:-]+)\s*=\s*["']([^"']*)["']/g)) out[m[1].toLowerCase()] = m[2]; return out; }
function decode(s: string): string { return s.replace(/&amp;/g,'&').replace(/&quot;/g,'"').replace(/&#39;|&apos;/g,"'").replace(/&lt;/g,'<').replace(/&gt;/g,'>'); }
function retryAfter(response:Response):number {
  const raw=response.headers.get('retry-after'), seconds=raw && /^\d+$/.test(raw) ? Number(raw) : NaN, date=raw ? Date.parse(raw) : NaN;
  return Math.max(300,Number.isFinite(seconds) ? seconds : Number.isFinite(date) ? Math.ceil((date-Date.now())/1000) : 300);
}
export async function inspectPublisher(url: string, sourceUrl: string | undefined, fetcher: Fetcher = fetch): Promise<Provenance> {
  const initial = safeUrl(url);
  const out: Provenance = { googleNewsUrl: initial?.hostname === 'news.google.com' ? url : null, originalUrl: null, resolutionStatus: 'invalid_url', publisherTitle: null, publisherPublishedAt: null, publisherText:null, verificationStatus: 'not_attempted' };
  if (!initial) return out;
  const source = sourceUrl ? safeUrl(sourceUrl) : null;
  let candidate: URL | null = initial;
  if (initial.hostname === 'news.google.com') {
    out.resolutionStatus = 'google_interstitial';
    if (!source) { out.resolutionStatus = 'source_host_unknown'; return out; }
    try {
      let current = initial;
      for (let i=0; i<3; i++) {
        const response = await fetcher(current.toString(), {redirect:'manual', signal:AbortSignal.timeout(8000)});
        if(response.status===429){out.resolutionStatus='google_http_429';out.retryAfterSeconds=retryAfter(response);return out;}
        const location = response.headers.get('location');
        if (response.status < 300 || response.status >= 400 || !location) return out;
        const next = safeUrl(new URL(location,current).toString());
        if (!next) { out.resolutionStatus='unsafe_redirect'; return out; }
        if (next.hostname === 'news.google.com') { current = next; continue; }
        if (!sameHost(next.hostname,source.hostname)) { out.resolutionStatus='redirect_source_mismatch'; return out; }
        candidate = next; break;
      }
      if (candidate.hostname === 'news.google.com') { out.resolutionStatus='redirect_limit'; return out; }
    } catch(e) { if(isLiveBudgetError(e))throw e; out.resolutionStatus='google_request_failed'; return out; }
  }
  if (!candidate) return out;
  out.originalUrl = candidate.toString();
  out.resolutionStatus = out.googleNewsUrl ? 'http_redirect' : 'direct_provider_url';
  try {
    const robots = await fetcher(`${candidate.origin}/robots.txt`, {redirect:'manual', signal:AbortSignal.timeout(8000), headers:{'User-Agent':'DialSyria-Discovery/1.0'}});
    if (robots.status === 429) { out.verificationStatus='robots_http_429'; out.retryAfterSeconds=retryAfter(robots); return out; }
    if (robots.status !== 404 && (!robots.ok || !allowedByRobots((await robots.text()).slice(0,100000),candidate.pathname))) { out.verificationStatus='robots_denied_or_unavailable'; return out; }
    const page = await fetcher(candidate.toString(), {redirect:'manual', signal:AbortSignal.timeout(8000), headers:{accept:'text/html','User-Agent':'DialSyria-Discovery/1.0'}});
    if (page.status === 429) { out.verificationStatus='publisher_http_429'; out.retryAfterSeconds=retryAfter(page); return out; }
    if (!page.ok || !page.headers.get('content-type')?.toLowerCase().includes('text/html')) { out.verificationStatus=`publisher_http_${page.status}`; return out; }
    const html = (await page.text()).slice(0,200000);
    let title: string | null = null; let published: string | null = null; let description:string | null = null;
    for (const tag of html.match(/<meta\b[^>]*>/gi) || []) {
      const a = attrs(tag); const key = (a.property || a.name || a.itemprop || '').toLowerCase();
      if (key === 'og:title' && a.content) title = decode(a.content);
      if (key === 'og:description' && a.content) description = decode(a.content);
      if (['article:published_time','datepublished'].includes(key) && a.content && /^\d{4}-\d{2}-\d{2}T.*(?:Z|[+-]\d{2}:?\d{2})$/i.test(a.content)) { const d = new Date(a.content); if (!isNaN(d.getTime())) published = d.toISOString(); }
    }
    for (const script of html.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script>/gi)) {
      if (attrs(script[1]).type?.toLowerCase() !== 'application/ld+json') continue;
      try {
        const root = JSON.parse(script[2]);
        const stack: unknown[] = [root]; let examined = 0;
        while (stack.length && examined++ < 100) {
          const entry = stack.pop(); if (Array.isArray(entry)) { stack.push(...entry); continue; }
          if (!entry || typeof entry !== 'object') continue;
          const obj = entry as Record<string,unknown>; if (obj['@graph']) stack.push(obj['@graph']);
          const types = Array.isArray(obj['@type']) ? obj['@type'] : [obj['@type']];
          if (!types.some(x => typeof x === 'string' && /(?:NewsArticle|Article|ReportageNewsArticle)$/i.test(x))) continue;
          if (!title && typeof obj.headline === 'string') title = obj.headline;
          if (!published && typeof obj.datePublished === 'string' && /^\d{4}-\d{2}-\d{2}T.*(?:Z|[+-]\d{2}:?\d{2})$/i.test(obj.datePublished)) { const d = new Date(obj.datePublished); if (!isNaN(d.getTime())) published = d.toISOString(); }
        }
      } catch { /* Malformed structured data is not evidence. */ }
    }
    const article=html.match(/<article\b[^>]*>([\s\S]*?)<\/article>/i)?.[1];
    const excerpt=article?.replace(/<(script|style)\b[^>]*>[\s\S]*?<\/\1>/gi,' ').replace(/<[^>]*>/g,' ').replace(/\s+/g,' ').trim();
    out.publisherTitle = title; out.publisherPublishedAt = published; out.publisherText = excerpt ? decode(excerpt).slice(0,5000) : description?.slice(0,5000) || null; out.verificationStatus = title || published ? 'publisher_metadata' : 'metadata_unavailable';
  } catch(e) { if(isLiveBudgetError(e))throw e; out.verificationStatus = 'publisher_request_failed'; }
  return out;
}
