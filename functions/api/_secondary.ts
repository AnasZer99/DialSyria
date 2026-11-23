import {parseFeed} from './_ingest';
import {allowedByRobots, inspectPublisher, safeUrl, type Provenance} from './_publisher';

function normalizeTitle(s: string): string {
  return s.toLowerCase().replace(/[\u064b-\u065f\u0670ـ]/g,'').replace(/[أإآٱ]/g,'ا').replace(/ى/g,'ي').replace(/ة/g,'ه').replace(/[^\p{L}\p{N}]+/gu,' ').trim().replace(/\s+/g,' ');
}
export async function lookupPublisherFeed(title: string, source: string, sourceUrl: string | undefined, googleNewsUrl: string, feedDate: string | null, fetcher: typeof fetch = fetch): Promise<Provenance | null> {
  const base = sourceUrl ? safeUrl(sourceUrl) : null;
  if (!base || ['news.google.com','t.me','telegram.me','facebook.com','www.facebook.com'].includes(base.hostname)) return null;
  const headers = {'User-Agent':'DialSyria-Discovery/1.0'};
  try {
    const robots=await fetcher(`${base.origin}/robots.txt`,{headers,redirect:'manual',signal:AbortSignal.timeout(6000)});
    if(robots.status!==404 && (!robots.ok || !allowedByRobots((await robots.text()).slice(0,100000),'/feed/'))) return null;
    const feed=await fetcher(`${base.origin}/feed/`,{headers,redirect:'manual',signal:AbortSignal.timeout(6000)});
    if(!feed.ok) return null;
    const sourceSuffix = source ? ` - ${source}` : '';
    const originalTitle=sourceSuffix && title.endsWith(sourceSuffix) ? title.slice(0,-sourceSuffix.length) : title;
    const key=normalizeTitle(originalTitle); if(key.length<15) return null;
    const matches=parseFeed((await feed.text()).slice(0,300000)).filter(item=>normalizeTitle(item.title)===key && safeUrl(item.link)?.hostname.replace(/^www\./,'')===base.hostname.replace(/^www\./,''));
    if(matches.length!==1) return null;
    const item=matches[0];
    if(feedDate && item.pubDate) { const pub=Date.parse(item.pubDate); if(Number.isFinite(pub) && Math.abs(pub-Date.parse(feedDate))>48*3600000) return null; }
    const verified=await inspectPublisher(item.link,sourceUrl,fetcher);
    if(!verified.originalUrl || !verified.publisherTitle || normalizeTitle(verified.publisherTitle)!==key) return null;
    if(feedDate && verified.publisherPublishedAt && Math.abs(Date.parse(feedDate)-Date.parse(verified.publisherPublishedAt))>48*3600000) return null;
    return {...verified,googleNewsUrl,resolutionStatus:'verified_publisher_feed'};
  } catch { return null; }
}
