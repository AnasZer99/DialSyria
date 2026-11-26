import { runDiscovery, normalize, type Database } from './_discovery';
import { discoverDirectSources, monitorDirectSources } from './_direct';
import { safeUrl } from './_publisher';
import { canonicalUrl, isPublisherVerified } from './_notify';
import { attachCandidateSources, sourceDetails } from './_source_catalog';
import { createLiveBudget, type LiveBudget } from './_live_budget';

// Free providers only. This is a per-run ceiling over *all* search, robots,
// publisher and source requests, including retries; it never contacts Telegram's bot API.
const MAX_REQUESTS = 24;
type Fetcher = typeof fetch;
type Result = { title: string; source: string; url: string; publishedAt: string | null; interest: string; sourceType: 'website' | 'telegram'; sourceRole:string; verification: string };

function directUrl(value: string | null): value is string {
  if (!value) return false;
  const url = safeUrl(value);
  return !!url && url.hostname !== 'news.google.com' && !/(?:^|\.)test$/i.test(url.hostname);
}

export async function runLiveInterest(db: Database, interest: string, fetcher: Fetcher = fetch, monitorOnly = false, sharedBudget?:LiveBudget, maxQueries=2) {
  const budget=sharedBudget || createLiveBudget(fetcher,18000,MAX_REQUESTS);
  const startRequests=budget.requests();
  const bounded=budget.fetcher;
  const errors: string[] = [];
  const warnings: string[] = [];
  const unverifiedReasons: Record<string,number> = {};
  const results: Result[] = [];
  const seenUrls = new Set<string>(), seenTitles = new Set<string>();
  const key = normalize(interest);
  let found = 0, accepted = 0, rejected = 0, unprocessed = 0, duplicates = 0, resultDuplicates = 0, verifiedCandidates = 0, unverifiedAccepted = 0;
  let queries: string[] = [], sourceSearchResults = 0, monitoredSources = 0;
  let incomplete = false;
  let searchStarted=false, sourceSearchStarted=false, fallbackStarted=false, searchFailed=false;
  const noteUnverified = (reason:string) => { unverifiedAccepted++; unverifiedReasons[reason] = (unverifiedReasons[reason] || 0) + 1; };

  const add = (result: Result) => {
    const url = canonicalUrl(result.url), title = normalize(result.title);
    if (seenUrls.has(url) || (title && seenTitles.has(title))) { resultDuplicates++; return; }
    seenUrls.add(url); if (title) seenTitles.add(title); results.push(result);
  };

  const candidates = await attachCandidateSources(db, interest);
  const disabledSources = candidates.filter(source=>!source.enabled).map(source=>({source:source.url,reason:source.reason}));
  // Monitoring comes first so provider search and publisher lookups cannot starve
  // the vetted, interest-matched sources of their bounded request budget.
  const monitor = await monitorDirectSources(db, interest, { fetcher: bounded,shouldStop:budget.exhausted });
  const observations=[...monitor.observations];
  const collectMonitor=async (part:typeof monitor)=>{
  incomplete ||= part.incomplete;
  found += part.observations.reduce((sum, row) => sum + row.entriesRead, 0);
  accepted += part.observations.reduce((sum, row) => sum + row.accepted, 0);
  rejected += part.observations.reduce((sum, row) => sum + row.rejected, 0);
  unprocessed += part.observations.reduce((sum, row) => sum + row.unprocessed, 0);
  errors.push(...part.errors);
  for (const item of part.items) {
    if (item.duplicate) duplicates++;
    if (!directUrl(item.url)) continue;
    const stored = await db.prepare(`SELECT di.title, di.url, di.published_at, di.verification_status, ds.name, ds.kind
      FROM direct_items di JOIN direct_sources ds ON ds.id=di.source_id
      JOIN direct_source_interests dsi ON dsi.source_id=ds.id
      WHERE di.url=? AND dsi.interest_key=?`).bind(item.url, key)
      .first<{title:string;url:string;published_at:string|null;verification_status:string;name:string;kind:string}>();
    if (!stored || stored.title !== item.title || !directUrl(stored.url) || stored.verification_status !== item.verification || !['website','telegram'].includes(stored.kind)) continue;
    verifiedCandidates++;
    add({title:stored.title,source:stored.name,url:stored.url,publishedAt:stored.published_at,interest,
      sourceType:stored.kind as 'website'|'telegram',sourceRole:sourceDetails(item.source)?.role || 'discovered',verification:item.verification});
  }
  };
  monitoredSources = monitor.observations.length;
  await collectMonitor(monitor);

  if (!monitorOnly && !budget.exhausted()) {
  const cooldown = await db.prepare('SELECT until_at FROM direct_provider_backoff WHERE provider=?').bind('google-news-rss').first<{until_at:string}>();
  if (cooldown && cooldown.until_at > new Date().toISOString()) {
    incomplete = true;
    searchFailed=true;
    warnings.push(`Google News search is cooling down until ${cooldown.until_at}; known sources can still be monitored.`);
  } else {
    searchStarted=true;
    const search = await runDiscovery(db, interest, { fetcher: bounded, maxQueries, directRelevance:true,shouldStop:budget.exhausted });
    searchFailed=search.errors.length>0;
    incomplete ||= search.incomplete;
    queries = search.queries;
    found += search.decisions.length;
    accepted += search.decisions.filter(item => item.accepted).length;
    rejected += search.decisions.filter(item => !item.accepted).length;
    duplicates += search.duplicates;
    errors.push(...search.errors); warnings.push(...search.warnings);
    for (const item of search.decisions) {
      if (!item.accepted) continue;
      if (!directUrl(item.originalUrl)) { noteUnverified(`unresolved: ${item.resolutionStatus}`); continue; }
      if (!isPublisherVerified(item.verificationStatus)) { noteUnverified(`publisher: ${item.verificationStatus}`); continue; }
      const stored = await db.prepare('SELECT title, original_url, verification_status, is_mock FROM discovery_items WHERE url=?').bind(item.url)
        .first<{title:string; original_url:string|null; verification_status:string|null; is_mock:number}>();
      if (!stored || stored.is_mock !== 0 || stored.title !== item.title || !directUrl(stored.original_url)
          || canonicalUrl(stored.original_url) !== canonicalUrl(item.originalUrl) || !isPublisherVerified(stored.verification_status)) { noteUnverified('stored provenance mismatch or mock'); continue; }
      verifiedCandidates++;
      add({ title:item.title, source:item.source || new URL(item.originalUrl).hostname, url:item.originalUrl,
        publishedAt:item.publisherPublishedAt || item.publishedAt, interest, sourceType:'website', sourceRole:'discovered', verification:item.verificationStatus });
    }
    const throttled = search.errors.find(error => error.includes('HTTP 429'));
    if (throttled) {
      const seconds = Math.max(300, Number(throttled.match(/Retry-After (\d+)s/)?.[1] || 0));
      const until = new Date(Math.min(8640000000000000, Date.now() + seconds * 1000)).toISOString();
      await db.prepare('INSERT INTO direct_provider_backoff (provider,until_at,reason) VALUES (?,?,?) ON CONFLICT(provider) DO UPDATE SET until_at=MAX(until_at,excluded.until_at),reason=excluded.reason')
        .bind('google-news-rss', until, 'HTTP 429').run();
      warnings.push(`Search or publisher rate limited; general search paused until ${until}.`);
    } else if (!search.errors.length && !budget.exhausted()) {
      sourceSearchStarted=true;
      const discovered = await discoverDirectSources(db, interest, { fetcher: bounded,shouldStop:budget.exhausted,maxQueries });
      incomplete ||= discovered.incomplete;
      searchFailed=discovered.errors.length>0;
      sourceSearchResults = discovered.results;
      errors.push(...discovered.errors);
      warnings.push(...discovered.limitations);
    }
  }

  } else if(monitorOnly) {
    warnings.push('Beta pilot: only known direct sources were monitored.');
  } else {
    incomplete=true;
    warnings.push('General search skipped: live discovery budget exhausted.');
  }
  // Independent fallback: at most one older page from an already monitored
  // public Telegram source, never another request to the failing provider.
  if(!monitorOnly && searchFailed && !budget.exhausted()) {
    const eligible=monitor.observations.find(row=>row.kind==='telegram' && row.accessible && row.nextBefore);
    if(eligible?.nextBefore) {
      fallbackStarted=true;
      const older=await monitorDirectSources(db,interest,{fetcher:bounded,shouldStop:budget.exhausted,olderTelegram:{source:eligible.source,before:eligible.nextBefore}});
      observations.push(...older.observations);
      await collectMonitor(older);
    } else warnings.push('Independent fallback skipped: no eligible recent Telegram page with a cursor.');
  } else if(!monitorOnly && searchFailed && budget.exhausted()) warnings.push('Independent fallback skipped: live discovery budget exhausted.');
  if (budget.remaining() <= 0) {
    incomplete = true;
    warnings.push('Live discovery time budget exhausted; remaining work was skipped.');
  }
  const requests=budget.requests()-startRequests;
  if(budget.exhausted() && budget.remaining()>0) warnings.push(`Network request budget reached (${MAX_REQUESTS}); remaining work was skipped.`);
  return { mode:'live' as const, interest, results, diagnostics:{ found, accepted, rejected, unprocessed,
    directlyVerified:results.length, verifiedCandidates, unverifiedAccepted, unverifiedReasons, duplicates, resultDuplicates, requests, requestLimit:MAX_REQUESTS,
    queries, sourceSearchResults, monitoredSources, sources:observations, disabledSources, errors, warnings,
    stages:{monitorAttempted:monitor.observations.length,monitorSkipped:Math.max(0,monitor.sources.length-monitor.observations.length),searchStarted,sourceSearchStarted,fallbackStarted},
    incomplete:incomplete || errors.length>0 || budget.exhausted() } };
}
