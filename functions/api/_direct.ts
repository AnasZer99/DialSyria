import { search, evaluate, normalize, generateQueries, type Database } from './_discovery';
import { allowedByRobots, inspectPublisher, safeUrl } from './_publisher';
import { parseFeed } from './_ingest';

type Fetcher = typeof fetch;
type Source = {id:string; url:string; kind:string; name:string};
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
function topicalEvidence(interest:string,content:string):boolean {
  const generic=new Set(['تحديثات','اخبار','جديد','جديده','متابعه','اجراءات','تسجيل','مواعيد','موعد','اختصاص','جامعة','جامعه','جامعات','حكوميه','سوريه','سوريا','دمشق','حلب','ادلب','حمص','حماه','لاذقيه','طرطوس','درعا','الزور','الرقة','رقه','الحسكه']);
  const terms=normalize(interest).split(' ').map(w=>w.replace(/^(وال|بال|لل|ال)/,'')).filter(w=>w.length>=4 && !generic.has(w));
  const text=normalize(content); return terms.length===0 || terms.some(t=>text.includes(t));
}
export function parseTelegram(html:string, channelUrl:string):Array<{url:string;text:string;publishedAt:string}> {
  const name=new URL(channelUrl).pathname.split('/').filter(Boolean).pop() || '';
  const chunks=html.split(/(?=<div class="tgme_widget_message_wrap)/i); const out=[];
  for(const block of chunks){ const post=block.match(/data-post="([A-Za-z0-9_]+)\/(\d+)"/i); const text=block.match(/<div class="tgme_widget_message_text[^\"]*"[^>]*>([\s\S]*?)<\/div>/i); const date=block.match(/<time[^>]*datetime="([^"]+)"/i);
    if(!post || post[1].toLowerCase()!==name.toLowerCase() || !text || !date || !Number.isFinite(Date.parse(date[1])))continue;
    const content=clean(text[1]); if(content)out.push({url:`https://t.me/${post[1]}/${post[2]}`,text:content,publishedAt:new Date(date[1]).toISOString()});
  } return out.slice(-20);
}
async function allowedFetch(url:string, fetcher:Fetcher):Promise<Response> {
  const u=safeUrl(url); if(!u)throw new Error('unsafe URL');
  const headers={'User-Agent':'DialSyria-Discovery/1.0'};
  const robots=await fetcher(`${u.origin}/robots.txt`,{headers,redirect:'manual',signal:AbortSignal.timeout(8000)});
  if(robots.status!==404 && (!robots.ok || !allowedByRobots((await robots.text()).slice(0,100000),u.pathname)))throw new Error('robots denied or unavailable');
  const res=await fetcher(u.toString(),{headers,redirect:'manual',signal:AbortSignal.timeout(8000)});
  if(!res.ok)throw new Error(`HTTP ${res.status}`); return res;
}
async function begin(db:Database,interest:string,mode:string) { const id=crypto.randomUUID(), started=new Date().toISOString(); await db.prepare('INSERT INTO direct_runs (id,interest_key,mode,started_at,status) VALUES (?,?,?,?,?)').bind(id,normalize(interest),mode,started,'running').run(); return {id,started}; }
async function finish(db:Database,id:string,report:unknown, incomplete:boolean) {await db.prepare('UPDATE direct_runs SET finished_at=?, status=?, report=? WHERE id=?').bind(new Date().toISOString(),incomplete?'incomplete':'complete',JSON.stringify(report),id).run();}

// Discovery is explicitly invoked. With no opted-in Brave key it uses the limited Google News index.
export async function discoverDirectSources(db:Database,interest:string,opts:{key?:string;fetcher?:Fetcher}={}) {
  if(interest.trim().length<3 || interest.length>300)throw new Error('invalid interest');
  const run=await begin(db,interest,'discovery'); const queries=generateQueries(interest).slice(0,2); const errors:string[]=[]; const discovered:Source[]=[]; let results=0;
  const provider=opts.key?'brave-or-rss':'google-news-rss';
  const cooldown=await db.prepare('SELECT until_at FROM direct_provider_backoff WHERE provider=?').bind(provider).first<{until_at:string}>();
  if(cooldown && cooldown.until_at>run.started) errors.push(`provider cooldown until ${cooldown.until_at}`);
  for(const q of errors.length ? [] : queries){try {const found=await search(q,opts.key,opts.fetcher); results+=found.items.length;
    for(const item of found.items){if(!evaluate(interest,item).accepted)continue; const source=sourceFrom(item.url,item.sourceUrl); if(!source)continue;
      const id=crypto.randomUUID(); const inserted=await db.prepare('INSERT OR IGNORE INTO direct_sources (id,url,kind,name,discovered_at) VALUES (?,?,?,?,?)').bind(id,source.url,source.kind,item.source || new URL(source.url).hostname,run.started).run();
      const row=inserted.meta.changes?{id,url:source.url,kind:source.kind,name:item.source || new URL(source.url).hostname}:await db.prepare('SELECT id,url,kind,name FROM direct_sources WHERE url=?').bind(source.url).first<Source>();
      if(row){await db.prepare('INSERT OR IGNORE INTO direct_source_interests (interest_key,source_id) VALUES (?,?)').bind(normalize(interest),row.id).run(); if(!discovered.some(x=>x.id===row.id))discovered.push(row);}
      if(discovered.length>=5)break;
    }
    if(discovered.length>=5)break;
  }catch(e){errors.push(`${q}: ${String(e)}`); if(String(e).includes('429')){const retry=String(e).match(/Retry-After (\d+)s/); const seconds=Math.max(300,retry?Number(retry[1]):300); const until=new Date(Math.min(8640000000000000,Date.now()+seconds*1000)).toISOString(); await db.prepare('INSERT INTO direct_provider_backoff (provider,until_at,reason) VALUES (?,?,?) ON CONFLICT(provider) DO UPDATE SET until_at=excluded.until_at,reason=excluded.reason').bind(provider,until,String(e)).run();break;}}}
  const report={...run,interest,mode:'discovery',provider,queries,results,discovered,errors,incomplete:errors.length>0,limitations:opts.key?[]:['No web search key: Google News cannot provide general web or Telegram discovery.']};
  await finish(db,run.id,report,report.incomplete);return report;
}

export async function monitorDirectSources(db:Database,interest:string,opts:{fetcher?:Fetcher}={}) {
  const run=await begin(db,interest,'monitor'); const fetcher=opts.fetcher || fetch; const errors:string[]=[]; const observations:Array<{source:string;entriesRead:number;accepted:number;rejected:number}> = []; const items:Array<{url:string;title:string;publishedAt:string|null;duplicate:boolean;source:string}> = [];
  const selected=await db.prepare('SELECT s.id,s.url,s.kind,s.name FROM direct_sources s JOIN direct_source_interests i ON i.source_id=s.id WHERE i.interest_key=? ORDER BY i.last_checked_at IS NOT NULL,i.last_checked_at LIMIT 5').bind(normalize(interest)).all<Source>();
  for(const s of selected.results){ try {
    const target=s.kind==='telegram'?s.url:s.url+'/feed/'; const res=await allowedFetch(target,fetcher); const text=(await res.text()).slice(0,500000);
    const entries=s.kind==='telegram'?parseTelegram(text,s.url).map(x=>({url:x.url,title:x.text.slice(0,180),content:x.text,publishedAt:x.publishedAt})):parseFeed(text).map(x=>({url:x.link,title:x.title,content:x.description||'',publishedAt:x.pubDate && Number.isFinite(Date.parse(x.pubDate))?new Date(x.pubDate).toISOString():null}));
    const obs={source:s.url,entriesRead:entries.length,accepted:0,rejected:0}; observations.push(obs);
    for(const entry of entries){const u=safeUrl(entry.url); if(!u)continue; if(s.kind==='website' && u.hostname.replace(/^www\./,'')!==new URL(s.url).hostname.replace(/^www\./,''))continue;
      const d=evaluate(interest,{title:entry.title,url:entry.url,description:entry.content,source:s.name,publishedAt:entry.publishedAt,provider:'direct'});if(!d.accepted || !topicalEvidence(interest,entry.title+' '+entry.content)){obs.rejected++;continue;}
      if(s.kind==='website'){const p=await inspectPublisher(entry.url,s.url,fetcher); if(!p.publisherTitle || normalize(p.publisherTitle)!==normalize(entry.title)){obs.rejected++;continue;} entry.publishedAt=p.publisherPublishedAt || entry.publishedAt;entry.content=p.publisherText || entry.content;}
      const inserted=await db.prepare('INSERT OR IGNORE INTO direct_items (id,source_id,url,title,content,published_at,first_seen) VALUES (?,?,?,?,?,?,?)').bind(crypto.randomUUID(),s.id,entry.url,entry.title,entry.content,entry.publishedAt,run.started).run();
      items.push({url:entry.url,title:entry.title,publishedAt:entry.publishedAt,duplicate:!inserted.meta.changes,source:s.url});
      obs.accepted++;
    }
    await db.prepare('UPDATE direct_sources SET last_checked_at=?,last_error=NULL WHERE id=?').bind(new Date().toISOString(),s.id).run();
  }catch(e){const msg=String(e);errors.push(`${s.url}: ${msg}`);await db.prepare('UPDATE direct_sources SET last_checked_at=?,last_error=? WHERE id=?').bind(new Date().toISOString(),msg,s.id).run();}}
  for(const s of selected.results) await db.prepare('UPDATE direct_source_interests SET last_checked_at=? WHERE interest_key=? AND source_id=?').bind(new Date().toISOString(),normalize(interest),s.id).run();
  const report={...run,interest,mode:'monitor',sources:selected.results,observations,items,errors,incomplete:errors.length>0};await finish(db,run.id,report,report.incomplete);return report;
}
