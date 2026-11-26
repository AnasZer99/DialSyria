import { search, evaluate, evaluateDirect, normalize, generateQueries, type Database } from './_discovery';
import { allowedByRobots, inspectPublisher, safeUrl } from './_publisher';
import { parseFeed } from './_ingest';
import { sourceDetails, institutionForVerifiedPost } from './_source_catalog';
import { isLiveBudgetError } from './_live_budget';
import type { InterestWriteGuard } from './_interest_guard';

type Fetcher = typeof fetch;
type Source = {id:string; url:string; kind:string; name:string};
type Entry={url:string;title:string;content:string;publishedAt:string|null;firstSeen?:string};
type Cursor={head_id:string|null;next_before:string|null;stop_after:string|null;window_start:string|null};
function channel(value:string):string | null {
  try { const u=new URL(value); if(!['t.me','telegram.me'].includes(u.hostname.toLowerCase()))return null;
    const parts=u.pathname.split('/').filter(Boolean); if(parts[0]==='s')parts.shift();
    const name=parts[0]; if(!name || !/^[a-zA-Z][a-zA-Z0-9_]{4,31}$/.test(name) || ['share','proxy','joinchat','iv','login','addstickers'].includes(name.toLowerCase()))return null;
    return `https://t.me/s/${name}`;
  } catch{return null;}
}
function sourceFrom(url:string, sourceUrl?:string):{url:string;kind:string}|null {
  const tg=channel(url); if(tg)return {url:tg,kind:'telegram'};
  const u=safeUrl(sourceUrl || url); if(!u || u.hostname==='news.google.com' || ['facebook.com','www.facebook.com'].includes(u.hostname))return null;
  return {url:u.origin,kind:'website'};
}
function clean(s:string):string {return s.replace(/<br\s*\/?\s*>/gi,'\n').replace(/<[^>]*>/g,' ').replace(/&amp;/g,'&').replace(/&lt;/g,'<').replace(/&gt;/g,'>').replace(/&quot;/g,'"').replace(/&#39;/g,"'").replace(/[ \t]+/g,' ').trim();}
export function parseTelegram(html:string, channelUrl:string):Array<{url:string;text:string;publishedAt:string}> {
  const name=new URL(channelUrl).pathname.split('/').filter(Boolean).pop() || '';
  const chunks=html.split(/(?=<div class="tgme_widget_message_wrap)/i); const out=[];
  for(const block of chunks){ const post=block.match(/data-post="([A-Za-z0-9_]+)\/(\d+)"/i); const text=block.match(/<div class="tgme_widget_message_text[^\"]*"[^>]*>([\s\S]*?)<\/div>/i); const date=block.match(/<time[^>]*datetime="([^"]+)"/i);
    if(!post || post[1].toLowerCase()!==name.toLowerCase() || !text || !date || !Number.isFinite(Date.parse(date[1])))continue;
    const content=clean(text[1]); if(content)out.push({url:`https://t.me/${post[1]}/${post[2]}`,text:content,publishedAt:new Date(date[1]).toISOString()});
  } return out.slice(-20);
}
async function allowedFetch(url:string, fetcher:Fetcher, robotsCache = new Map<string,string|null>()):Promise<Response> {
  const u=safeUrl(url); if(!u)throw new Error('unsafe URL');
  const headers={'User-Agent':'DialSyria-Discovery/1.0'};
  if(!robotsCache.has(u.origin)) {
    const robots=await fetcher(`${u.origin}/robots.txt`,{headers,redirect:'manual',signal:AbortSignal.timeout(8000)});
    if(robots.status===429)throw new Error(`HTTP 429 Retry-After ${retryAfter(robots)}s`);
    if(robots.status!==404 && !robots.ok)throw new Error('robots denied or unavailable');
    robotsCache.set(u.origin,robots.status===404 ? null : (await robots.text()).slice(0,100000));
  }
  const rules=robotsCache.get(u.origin);
  if(rules !== null && rules !== undefined && !allowedByRobots(rules,u.pathname+u.search))throw new Error('robots denied or unavailable');
  const res=await fetcher(u.toString(),{headers,redirect:'manual',signal:AbortSignal.timeout(8000)});
  if(res.status===429)throw new Error(`HTTP 429 Retry-After ${retryAfter(res)}s`);
  if(!res.ok)throw new Error(`HTTP ${res.status}`); return res;
}
function retryAfter(response:Response):number {
  const raw=response.headers.get('retry-after'); const number=raw && /^\d+$/.test(raw) ? Number(raw) : NaN;
  const date=raw ? Date.parse(raw) : NaN;
  return Math.max(300,Number.isFinite(number) ? number : Number.isFinite(date) ? Math.ceil((date-Date.now())/1000) : 300);
}
async function begin(db:Database,interest:string,mode:string) { const id=crypto.randomUUID(), started=new Date().toISOString(); await db.prepare('INSERT INTO direct_runs (id,interest_key,mode,started_at,status) VALUES (?,?,?,?,?)').bind(id,normalize(interest),mode,started,'running').run(); return {id,started}; }
// Persist aggregate diagnostics only: provider errors can embed the search query,
// private interest text, URLs or other untrusted response content.
function safeDirectReport(report:unknown) {
  const r=report as {mode?:string;results?:number;discovered?:unknown[];errors?:string[];observations?:Array<{kind:string;accessible:boolean;entriesRead:number;relevant:number;accepted:number;rejected:number;unprocessed:number;verified:number;paginationPending?:boolean;failedCandidates?:number}>};
  const code=(value:string)=>/429|cooldown/i.test(value)?'rate_limited':/timed out|budget exhausted/i.test(value)?'deadline_or_timeout':/robots/i.test(value)?'robots_unavailable':/HTTP \d+/i.test(value)?'http_error':'source_or_search_unavailable';
  return {mode:r.mode,results:r.results ?? 0,discoveredCount:r.discovered?.length ?? 0,errorCodes:(r.errors || []).map(code),observations:(r.observations || []).map(o=>({kind:o.kind,accessible:o.accessible,entriesRead:o.entriesRead,relevant:o.relevant,accepted:o.accepted,rejected:o.rejected,unprocessed:o.unprocessed,verified:o.verified,paginationPending:o.paginationPending||false,failedCandidates:o.failedCandidates||0}))};
}
async function finish(db:Database,id:string,report:unknown, incomplete:boolean) {await db.prepare('UPDATE direct_runs SET finished_at=?, status=?, report=? WHERE id=?').bind(new Date().toISOString(),incomplete?'incomplete':'complete',JSON.stringify(safeDirectReport(report)),id).run();}

// Discovery is explicitly invoked. With no opted-in Brave key it uses the limited Google News index.
export async function discoverDirectSources(db:Database,interest:string,opts:{key?:string;fetcher?:Fetcher;shouldStop?:()=>boolean;maxQueries?:number;authorize?:()=>Promise<boolean>;guard?:InterestWriteGuard}={}) {
  if(interest.trim().length<3 || interest.length>300)throw new Error('invalid interest');
  const run=await begin(db,interest,'discovery'); const queries=generateQueries(interest).slice(0,opts.maxQueries ?? 2); const errors:string[]=[]; const discovered:Source[]=[]; let results=0;
  const provider=opts.key?'brave-or-rss':'google-news-rss';
  const cooldown=await db.prepare('SELECT until_at FROM direct_provider_backoff WHERE provider=?').bind(provider).first<{until_at:string}>();
  if(cooldown && cooldown.until_at>run.started) errors.push(`provider cooldown until ${cooldown.until_at}`);
  for(const q of errors.length ? [] : queries){if(opts.shouldStop?.()){errors.push('live discovery budget exhausted before remaining source searches');break;}try {const found=await search(q,opts.key,opts.fetcher); results+=found.items.length;
    for(const item of found.items){if(opts.shouldStop?.() || (opts.authorize && !await opts.authorize())){errors.push('source processing interrupted');break;}if(!evaluate(interest,item).accepted)continue; const source=sourceFrom(item.url,item.sourceUrl); if(!source)continue;
      const guard=opts.guard;
      const id=crypto.randomUUID(); const inserted=await db.prepare(`INSERT OR IGNORE INTO direct_sources (id,url,kind,name,discovered_at) SELECT ?,?,?,?,?${guard ? ` WHERE ${guard.sql}` : ''}`).bind(id,source.url,source.kind,item.source || new URL(source.url).hostname,run.started,...(guard?.args() || [])).run();
      const row=inserted.meta.changes?{id,url:source.url,kind:source.kind,name:item.source || new URL(source.url).hostname}:await db.prepare('SELECT id,url,kind,name FROM direct_sources WHERE url=?').bind(source.url).first<Source>();
      if(row){const linked=await db.prepare(`INSERT OR IGNORE INTO direct_source_interests (interest_key,source_id) SELECT ?,?${guard ? ` WHERE ${guard.sql}` : ''}`).bind(normalize(interest),row.id,...(guard?.args() || [])).run(); if((linked.meta.changes || !guard || !opts.authorize || await opts.authorize()) && !discovered.some(x=>x.id===row.id))discovered.push(row);}
      if(discovered.length>=5)break;
    }
    if(discovered.length>=5)break;
  }catch(e){errors.push(`${q}: ${String(e)}`); if(String(e).includes('429')){const retry=String(e).match(/Retry-After (\d+)s/); const seconds=Math.max(300,retry?Number(retry[1]):300); const until=new Date(Math.min(8640000000000000,Date.now()+seconds*1000)).toISOString(); await db.prepare('INSERT INTO direct_provider_backoff (provider,until_at,reason) VALUES (?,?,?) ON CONFLICT(provider) DO UPDATE SET until_at=MAX(until_at,excluded.until_at),reason=excluded.reason').bind(provider,until,String(e)).run();break;}}}
  const report={...run,interest,mode:'discovery',provider,queries,results,discovered,errors,incomplete:errors.length>0,limitations:opts.key?[]:['No web search key: Google News cannot provide general web or Telegram discovery.']};
  await finish(db,run.id,report,report.incomplete);return report;
}

export async function monitorDirectSources(db:Database,interest:string,opts:{fetcher?:Fetcher;shouldStop?:()=>boolean;olderTelegram?:{source:string;before:string};authorize?:()=>Promise<boolean>;guard?:InterestWriteGuard;durable?:boolean;lookbackHours?:number}={}) {
  const run=await begin(db,interest,'monitor'); const fetcher=opts.fetcher || fetch; const errors:string[]=[];
  const observations:Array<{source:string;kind:string;role:string;accessible:boolean;entriesRead:number;relevant:number;accepted:number;rejected:number;unprocessed:number;verified:number;latestPublishedAt:string|null;nextBefore:string|null;paginationPending:boolean;failedCandidates:number;reasons:Record<string,number>}> = [];
  const items:Array<{url:string;title:string;publishedAt:string|null;duplicate:boolean;source:string;verification:string}> = [];
  const rows=await db.prepare('SELECT s.id,s.url,s.kind,s.name FROM direct_sources s JOIN direct_source_interests i ON i.source_id=s.id WHERE i.interest_key=? ORDER BY i.last_checked_at IS NOT NULL,i.last_checked_at LIMIT 20').bind(normalize(interest)).all<Source>();
  const selected=rows.results.sort((a,b)=>Number(!!sourceDetails(b.url)?.enabled)-Number(!!sourceDetails(a.url)?.enabled)).slice(0,5).filter(s=>!opts.olderTelegram || (s.kind==='telegram' && s.url===opts.olderTelegram.source && /^\d{1,16}$/.test(opts.olderTelegram.before)));
  const robotsCache=new Map<string,string|null>();
  const attempted:string[]=[];
  for(const s of selected){
    if(opts.shouldStop?.() || (opts.authorize && !await opts.authorize())){errors.push('source monitoring interrupted before remaining sources');break;}
    attempted.push(s.id);
    const configured=sourceDetails(s.url);
    const obs={source:s.url,kind:s.kind,role:configured?.role || 'discovered',accessible:false,entriesRead:0,relevant:0,accepted:0,rejected:0,unprocessed:0,verified:0,latestPublishedAt:null as string|null,nextBefore:null as string|null,paginationPending:false,failedCandidates:0,reasons:{} as Record<string,number>}; observations.push(obs);
    const reject=(reason:string)=>{obs.rejected++;obs.reasons[reason]=(obs.reasons[reason]||0)+1;};
    const provider='source:'+new URL(s.url).hostname.toLowerCase();
    let sourceFailure:string|null=null,skippedKnown=0;
    const backoff=async (message:string)=>{
      const seconds=Math.max(300,Number(message.match(/Retry-After (\d+)s/)?.[1] || 0));
      const until=new Date(Math.min(8640000000000000,Date.now()+seconds*1000)).toISOString();
      await db.prepare('INSERT INTO direct_provider_backoff (provider,until_at,reason) VALUES (?,?,?) ON CONFLICT(provider) DO UPDATE SET until_at=MAX(until_at,excluded.until_at),reason=excluded.reason').bind(provider,until,'HTTP 429').run();
    };
    try {
      const cooldown=await db.prepare('SELECT until_at FROM direct_provider_backoff WHERE provider=?').bind(provider).first<{until_at:string}>();
      if(cooldown && cooldown.until_at>new Date().toISOString())throw new Error(`source cooldown until ${cooldown.until_at}`);
      const interestKey=normalize(interest),guard=opts.guard;
      const cursor=opts.durable && s.kind==='telegram'?await db.prepare('SELECT head_id,next_before,stop_after,window_start FROM direct_monitor_cursors WHERE interest_key=? AND source_id=?').bind(interestKey,s.id).first<Cursor>():null;
      const before=opts.olderTelegram?.before || cursor?.next_before || null;
      if(before && !/^\d{1,16}$/.test(before))throw new Error('invalid persisted pagination cursor');
      const target=s.kind==='telegram'?s.url+(before ? `?before=${before}` : ''):s.url.replace(/\/$/,'')+'/feed/'; const res=await allowedFetch(target,fetcher,robotsCache); const text=(await res.text()).slice(0,500000);
      if(s.kind==='telegram' && configured) {
        const title=text.match(/<meta\s+property=["']og:title["']\s+content=["']([^"']+)/i)?.[1] || '';
        if(normalize(clean(title))!==normalize(s.name))throw new Error('channel identity does not match configured source');
      }
      obs.accessible=true;
      const parsed=s.kind==='telegram'?parseTelegram(text,s.url):[];
      let entries:Entry[]=s.kind==='telegram'?parsed.filter(x=>{if(!before)return true;const id=x.url.split('/').pop()!;return /^\d{1,16}$/.test(id) && BigInt(id)<BigInt(before);}).map(x=>({url:x.url,title:x.text.slice(0,180),content:x.text,publishedAt:x.publishedAt})):parseFeed(text,40).map(x=>({url:x.link,title:x.title,content:x.description||'',publishedAt:x.pubDate && Number.isFinite(Date.parse(x.pubDate))?new Date(x.pubDate).toISOString():null}));
      if(before && parsed.length && !entries.length)throw new Error('pagination did not advance');
      obs.entriesRead=entries.length;
      obs.latestPublishedAt=entries.map(x=>x.publishedAt).filter((x):x is string=>!!x).sort().at(-1) || null;
      if(s.kind==='telegram' && !opts.olderTelegram && entries.length && entries.every(x=>x.publishedAt && Date.parse(x.publishedAt)>=Date.now()-30*86400000)) {
        const ids=entries.map(x=>x.url.split('/').pop()!).filter(id=>/^\d{1,16}$/.test(id)).map(id=>BigInt(id));
        if(ids.length)obs.nextBefore=ids.reduce((a,b)=>a<b?a:b).toString();
      }
      if(opts.durable){
        // Persist all relevant listing entries before moving the page cursor. A
        // crash before that point simply rereads the page and INSERT OR IGNORE
        // preserves the original observation time and verification attempts.
        const toPersist:Array<{entry:Entry;score:number}>=[];
        for(const entry of entries){
          if(opts.shouldStop?.())throw new Error('live discovery time budget exhausted');
          const u=safeUrl(entry.url);
          if(!u){reject('invalid URL');continue;}
          if(s.kind==='website' && u.hostname.replace(/^www\./,'')!==new URL(s.url).hostname.replace(/^www\./,'')){reject('publisher host mismatch');continue;}
          const institution=institutionForVerifiedPost(s.url,s.kind,s.name,entry.url);
          const decision=evaluateDirect(interest,{title:entry.title,url:entry.url,description:entry.content,source:s.name,publishedAt:entry.publishedAt,provider:'direct'},Date.now(),institution);
          if(!decision.accepted){reject(decision.reason);continue;}
          toPersist.push({entry,score:decision.score});
        }
        // Eight rows per statement stays below D1's bound-parameter ceiling,
        // including the authorization guard. Each chunk is atomic and fenced.
        for(let i=0;i<toPersist.length;i+=8){
          if(opts.shouldStop?.() || (!guard && opts.authorize && !await opts.authorize()))throw new Error('live discovery time budget exhausted');
          const batch=toPersist.slice(i,i+8),rows=batch.map(()=>`(?,?,?,?,?,?,?,?,?)`).join(',');
          const args=batch.flatMap(({entry,score})=>[interestKey,s.id,entry.url,entry.title,entry.content,entry.publishedAt,run.started,score,run.started]);
          await db.prepare(`INSERT OR IGNORE INTO direct_monitor_candidates (interest_key,source_id,url,title,content,published_at,first_seen,score,updated_at) SELECT * FROM (VALUES ${rows})${guard ? ` WHERE ${guard.sql}` : ''}`)
            .bind(...args,...(guard?.args() || [])).run();
        }
        if(opts.authorize && !await opts.authorize())throw new Error('interest authorization changed');
        if(s.kind==='telegram'){
          const ids=entries.map(x=>x.url.split('/').pop()!).filter(x=>/^\d{1,16}$/.test(x)).map(x=>BigInt(x));
          const min=ids.length?ids.reduce((a,b)=>a<b?a:b):null,max=ids.length?ids.reduce((a,b)=>a>b?a:b):null;
          const hours=Number.isFinite(opts.lookbackHours) && opts.lookbackHours!>=1 && opts.lookbackHours!<=168?opts.lookbackHours!:72;
          const floor=cursor?.window_start || new Date(Date.now()-hours*3600000).toISOString();
          const oldest=entries.map(x=>x.publishedAt).filter((x):x is string=>!!x).sort()[0] || null;
          let head=cursor?.head_id || null,next:string|null=null,stop:string|null=null,windowStart:string|null=null;
          if(before){
            head=cursor?.head_id || null;stop=cursor?.stop_after || null;
            if(min!==null && oldest && oldest>=floor && (!stop || min>BigInt(stop))){next=min.toString();windowStart=floor;}
          }else if(max!==null && min!==null){
            const old=cursor?.head_id && /^\d{1,16}$/.test(cursor.head_id)?BigInt(cursor.head_id):null;
            head=(!old || max>old?max:old).toString();
            if(oldest && oldest>=floor && (!old || min>old)){next=min.toString();stop=old?.toString() || null;windowStart=floor;}
          }
          await db.prepare(`INSERT INTO direct_monitor_cursors (interest_key,source_id,head_id,next_before,stop_after,window_start,updated_at) SELECT ?,?,?,?,?,?,?${guard ? ` WHERE ${guard.sql}` : ''} ON CONFLICT(interest_key,source_id) DO UPDATE SET head_id=excluded.head_id,next_before=excluded.next_before,stop_after=excluded.stop_after,window_start=excluded.window_start,updated_at=excluded.updated_at`)
            .bind(interestKey,s.id,head,next,stop,windowStart,new Date().toISOString(),...(guard?.args() || [])).run();
          obs.paginationPending=!!next;
        }
        await db.prepare(`UPDATE direct_monitor_candidates SET status='pending',attempts=0,next_attempt_at=NULL,updated_at=? WHERE interest_key=? AND source_id=? AND status='failed' AND next_attempt_at<=?${guard ? ` AND ${guard.sql}` : ''}`)
          .bind(new Date().toISOString(),interestKey,s.id,new Date().toISOString(),...(guard?.args() || [])).run();
        const pending=await db.prepare("SELECT url,title,content,published_at AS publishedAt,first_seen AS firstSeen FROM direct_monitor_candidates WHERE interest_key=? AND source_id=? AND status='pending' AND (next_attempt_at IS NULL OR next_attempt_at<=?) ORDER BY first_seen ASC,score DESC,published_at DESC,url LIMIT 4")
          .bind(interestKey,s.id,new Date().toISOString()).all<Entry>();
        entries=pending.results;
      }
      // Verify unseen entries first so a busy source cannot spend its fixed
      // per-cycle budget rechecking the same four posts forever. Existing items
      // are still verified again before they appear in this run's results.
      const knownEntries=new Set<string>();
      if(!opts.durable){const known=await db.prepare("SELECT url,title FROM direct_items WHERE source_id=? AND verification_status IN ('telegram_post_verified','publisher_title_match') AND first_seen>=?").bind(s.id,new Date(Date.now()-30*86400000).toISOString()).all<{url:string;title:string}>();for(const row of known.results)knownEntries.add(JSON.stringify([row.url,row.title]));}
      const alreadyStored=(entry:{url:string;title:string})=>knownEntries.has(JSON.stringify([entry.url,entry.title]));
      if(!opts.durable)entries.sort((a,b)=>Number(alreadyStored(a))-Number(alreadyStored(b)) || (b.publishedAt || '').localeCompare(a.publishedAt || ''));
      let verificationAttempts=0;
      for(const entry of entries){
        const mark=async(state:'verified'|'rejected'|'retry'|'rate_limited',reason:string)=>{
          if(!opts.durable)return true;
          const time=new Date().toISOString(),next=new Date(Date.now()+5*60000).toISOString(),later=new Date(Date.now()+6*3600000).toISOString();
          const retry=state==='retry',rate=state==='rate_limited';
          const update=await db.prepare(`UPDATE direct_monitor_candidates SET status=${retry?"CASE WHEN attempts+1>=3 THEN 'failed' ELSE 'pending' END":rate?"'pending'":'?'}${retry?',attempts=attempts+1':''},next_attempt_at=${retry?'CASE WHEN attempts+1>=3 THEN ? ELSE ? END':'?'},last_error=?,updated_at=? WHERE interest_key=? AND source_id=? AND url=?${guard ? ` AND ${guard.sql}` : ''}`)
            .bind(...(retry||rate?[]:[state]),...(retry?[later,next]:[rate?next:null]),reason,time,interestKey,s.id,entry.url,...(guard?.args() || [])).run();
          return !!update.meta.changes;
        };
        if(opts.shouldStop?.() || (!guard && opts.authorize && !await opts.authorize())){errors.push(`${s.url}: source monitoring interrupted before remaining entries`);break;}
        const u=safeUrl(entry.url); if(!u){reject('invalid URL');await mark('rejected','invalid_url');continue;}
        if(s.kind==='website' && u.hostname.replace(/^www\./,'')!==new URL(s.url).hostname.replace(/^www\./,'')){reject('publisher host mismatch');await mark('rejected','publisher_host_mismatch');continue;}
        const institution=institutionForVerifiedPost(s.url,s.kind,s.name,entry.url);
        const d=evaluateDirect(interest,{title:entry.title,url:entry.url,description:entry.content,source:s.name,publishedAt:entry.publishedAt,provider:'direct'},Date.now(),institution);
        if(!d.accepted){reject(d.reason);await mark('rejected','relevance');continue;}
        obs.relevant++;
        if(verificationAttempts>=4){
          if(alreadyStored(entry)){skippedKnown++;continue;}
          const reason='per-source verification budget exhausted';obs.reasons[reason]=(obs.reasons[reason]||0)+1;continue;
        }
        verificationAttempts++;
        let verification='';
        try {
          if(s.kind==='website'){
            const p=await inspectPublisher(entry.url,s.url,fetcher);
            if(p.verificationStatus!=='publisher_metadata'){
              if(p.verificationStatus.includes('http_429')) {if(!opts.durable)reject(`publisher verification: ${p.verificationStatus}`);await mark('rate_limited','rate_limited');sourceFailure=`publisher HTTP 429 Retry-After ${p.retryAfterSeconds || 300}s`;errors.push(`${s.url}: ${sourceFailure}`);await backoff(sourceFailure);break;}
              if(opts.durable && /request_failed|http_5\d\d/.test(p.verificationStatus)){await mark('retry','publisher_unavailable');errors.push(`${s.url}: publisher unavailable`);break;}
              reject(`publisher verification: ${p.verificationStatus}`);await mark('rejected','publisher_unverified');
              continue;
            }
            if(!p.publisherTitle){reject('publisher title missing');await mark('rejected','publisher_title_missing');continue;}
            if(normalize(p.publisherTitle)!==normalize(entry.title)){reject('publisher title mismatch');await mark('rejected','publisher_title_mismatch');continue;}
            if(entry.publishedAt && p.publisherPublishedAt && Math.abs(Date.parse(entry.publishedAt)-Date.parse(p.publisherPublishedAt))>48*3600000){reject('publisher date mismatch');await mark('rejected','publisher_date_mismatch');continue;}
            entry.publishedAt=p.publisherPublishedAt || entry.publishedAt;entry.content=p.publisherText || entry.content;verification='publisher_title_match';
          } else if(s.kind==='telegram') {
            const postUrl=new URL(entry.url), postId=postUrl.pathname.split('/').filter(Boolean).pop();
            const detail=await allowedFetch(`${s.url.replace(/\/$/,'')}/${postId}`,fetcher,robotsCache);
            const posts=parseTelegram((await detail.text()).slice(0,500000),s.url);
            const exact=posts.find(post=>post.url.toLowerCase()===entry.url.toLowerCase());
            if(!exact || exact.text!==entry.content || exact.publishedAt!==entry.publishedAt){reject('post permalink verification mismatch');await mark('rejected','post_mismatch');continue;}
            verification='telegram_post_verified';
          } else {reject('unsupported source kind');await mark('rejected','unsupported_source');continue;}
        } catch(e) {
          const message=String(e);if(isLiveBudgetError(e)){await mark('retry','timeout');sourceFailure=message;errors.push(`${s.url}: ${message}`);obs.reasons[`verification incomplete: ${message}`]=(obs.reasons[`verification incomplete: ${message}`]||0)+1;break;}
          if(message.includes('HTTP 429')){if(!opts.durable)reject(`verification failed: ${message}`);await mark('rate_limited','rate_limited');sourceFailure=message;errors.push(`${s.url}: ${message}`);await backoff(message);break;}
          if(opts.durable){await mark('retry','verification_unavailable');errors.push(`${s.url}: verification unavailable`);break;}
          reject(`verification failed: ${message}`);
          continue;
        }
        // The actual publisher body must still satisfy relevance after extraction.
        if(!evaluateDirect(interest,{title:entry.title,url:entry.url,description:entry.content,source:s.name,publishedAt:entry.publishedAt,provider:'direct'},Date.now(),institution).accepted){reject('publisher content no longer matches interest');await mark('rejected','publisher_relevance');continue;}
        if(!guard && opts.authorize && !await opts.authorize()){errors.push(`${s.url}: source monitoring interrupted before storage`);break;}
        const inserted=await db.prepare(`INSERT OR IGNORE INTO direct_items (id,source_id,url,title,content,published_at,first_seen,verification_status) SELECT ?,?,?,?,?,?,?,?${guard ? ` WHERE ${guard.sql}` : ''}`).bind(crypto.randomUUID(),s.id,entry.url,entry.title,entry.content,entry.publishedAt,entry.firstSeen || run.started,verification,...(guard?.args() || [])).run();
        let saved=!!inserted.meta.changes;
        if(!saved){const updated=await db.prepare(`UPDATE direct_items SET content=?,published_at=?,verification_status=? WHERE source_id=? AND url=? AND title=?${guard ? ` AND ${guard.sql}` : ''}`).bind(entry.content,entry.publishedAt,verification,s.id,entry.url,entry.title,...(guard?.args() || [])).run();saved=!!updated.meta.changes;}
        if(!guard && opts.authorize && !await opts.authorize()){errors.push(`${s.url}: source monitoring interrupted during storage`);break;}
        if(!opts.durable){const stored=await db.prepare('SELECT id FROM direct_items WHERE source_id=? AND url=? AND title=? AND verification_status=?').bind(s.id,entry.url,entry.title,verification).first<{id:string}>();saved=!!stored;}
        if(!saved){if(guard && opts.authorize && !await opts.authorize()){errors.push(`${s.url}: source monitoring interrupted during storage`);break;}reject('stored source identity mismatch');await mark('rejected','stored_identity_mismatch');continue;}
        if(!await mark('verified','')){errors.push(`${s.url}: source monitoring interrupted after storage`);break;}
        items.push({url:entry.url,title:entry.title,publishedAt:entry.publishedAt,duplicate:!inserted.meta.changes,source:s.url,verification});
        obs.accepted++;obs.verified++;
      }
      await db.prepare(`UPDATE direct_sources SET last_checked_at=?,last_error=? WHERE id=?${opts.guard ? ` AND ${opts.guard.sql}` : ''}`).bind(new Date().toISOString(),sourceFailure,s.id,...(opts.guard?.args() || [])).run();
    }catch(e){const msg=String(e);if(msg.includes('HTTP 429'))await backoff(msg);errors.push(`${s.url}: ${msg}`);obs.reasons[`source failure: ${msg}`]=1;await db.prepare(`UPDATE direct_sources SET last_checked_at=?,last_error=? WHERE id=?${opts.guard ? ` AND ${opts.guard.sql}` : ''}`).bind(new Date().toISOString(),msg,s.id,...(opts.guard?.args() || [])).run();}
    if(opts.durable){
      const status=await db.prepare("SELECT COALESCE(SUM(CASE WHEN status='pending' THEN 1 ELSE 0 END),0) AS pending,COALESCE(SUM(CASE WHEN status='failed' THEN 1 ELSE 0 END),0) AS failed,(SELECT next_before FROM direct_monitor_cursors WHERE interest_key=? AND source_id=?) AS next_before FROM direct_monitor_candidates WHERE interest_key=? AND source_id=?")
        .bind(normalize(interest),s.id,normalize(interest),s.id).first<{pending:number;failed:number;next_before:string|null}>();
      obs.unprocessed=status?.pending || 0;obs.failedCandidates=status?.failed || 0;obs.paginationPending=!!status?.next_before;
      if(obs.unprocessed)obs.reasons['verification pending']=obs.unprocessed;
      if(obs.failedCandidates)obs.reasons['verification retries exhausted']=obs.failedCandidates;
    } else obs.unprocessed=Math.max(0,obs.entriesRead-obs.accepted-obs.rejected-skippedKnown);
  }
  for(const id of attempted) await db.prepare(`UPDATE direct_source_interests SET last_checked_at=? WHERE interest_key=? AND source_id=?${opts.guard ? ` AND ${opts.guard.sql}` : ''}`).bind(new Date().toISOString(),normalize(interest),id,...(opts.guard?.args() || [])).run();
  const report={...run,interest,mode:'monitor',sources:selected,observations,items,errors,incomplete:errors.length>0 || observations.some(o=>Object.keys(o.reasons).some(r=>r.startsWith('verification failed:') || r==='per-source verification budget exhausted' || r==='verification pending' || r==='verification retries exhausted'))};await finish(db,run.id,report,report.incomplete);return report;
}
