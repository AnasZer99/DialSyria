import { normalize, type Database } from './_discovery';
import type { InterestWriteGuard } from './_interest_guard';

// Candidates are deliberately editable and narrow. Disabled sites were inspected:
// idlib.university/feed/ returned 410 and mohe.gov.sy timed out in November 2026.
// Telegram channel identity is self-declared; SANA is third-party news reporting.
export const SOURCE_CANDIDATES = [
  {id:'idlib-website',url:'https://idlib.university/',name:'جامعة إدلب — الموقع المرشح',kind:'website',role:'institutional_candidate',enabled:false,reason:'No usable RSS feed found; /feed/ returned HTTP 410.',topic:'university'},
  {id:'idlib-edu-website',url:'https://idlib.edu.sy/',name:'جامعة إدلب — نطاق مرشح غير متحقق',kind:'website',role:'institutional_candidate',enabled:false,reason:'Accessibility, ownership, robots rules and publication structure have not been verified.',topic:'university'},
  {id:'idlib-telegram',url:'https://t.me/s/IdlebUniversity',name:'جامعة إدلب',kind:'telegram',role:'institutional_self_declared',enabled:true,reason:'',topic:'university'},
  {id:'ministry-website',url:'https://mohe.gov.sy/',name:'وزارة التعليم العالي — الموقع المرشح',kind:'website',role:'institutional_candidate',enabled:false,reason:'Website or robots request timed out during inspection.',topic:'ministry'},
  {id:'ministry-telegram',url:'https://t.me/s/SyMOHEASR',name:'وزارة التعليم العالي والبحث العلمي السورية',kind:'telegram',role:'institutional_self_declared',enabled:true,reason:'',topic:'ministry'},
  {id:'sana-idlib',url:'https://sana.sy/governorates/edlib',name:'سانا — إدلب',kind:'website',role:'news_agency',enabled:true,reason:'',topic:'infrastructure'},
] as const;

function matches(topic:string, interest:string):boolean {
  const text=normalize(interest);
  if(topic==='university') return text.includes('ادلب') && text.includes('جامع');
  if(topic==='ministry') return /وزاره.*تعليم|تعليم.*عالي/.test(text);
  return text.includes('ادلب') && /خدمات|بنيه|تحتيه|مياه|صرف صحي|طرق|مشاريع/.test(text);
}

export function sourceDetails(url:string) { return SOURCE_CANDIDATES.find(source=>source.url.toLowerCase()===url.replace(/\/$/,'').toLowerCase()); }

// Only call after checking the channel identity (or a stored verified post).
export function institutionForVerifiedPost(sourceUrl:string,kind:string,name:string,postUrl:string):{institution:'idlib_university'|'higher_education_ministry'} | undefined {
  const source=sourceDetails(sourceUrl);
  if(!source || !source.enabled || kind!=='telegram' || normalize(name)!==normalize(source.name))return undefined;
  const channel=source.id==='idlib-telegram'?'IdlebUniversity':source.id==='ministry-telegram'?'SyMOHEASR':null;
  if(!channel)return undefined;
  try {const u=new URL(postUrl);const parts=u.pathname.split('/').filter(Boolean);if(u.protocol!=='https:' || u.hostname.toLowerCase()!=='t.me' || u.username || u.password || u.port || u.search || u.hash || parts.length!==2 || parts[0].toLowerCase()!==channel.toLowerCase() || !/^\d+$/.test(parts[1]))return undefined;}
  catch{return undefined;}
  return {institution:source.id==='idlib-telegram'?'idlib_university':'higher_education_ministry'};
}

export async function attachCandidateSources(db:Database,interest:string,opts:{authorize?:()=>Promise<boolean>;guard?:InterestWriteGuard}={}) {
  const selected=SOURCE_CANDIDATES.filter(source=>matches(source.topic,interest));
  const key=normalize(interest), now=new Date().toISOString();
  for(const source of selected.filter(source=>source.enabled)) {
    if(opts.authorize && !await opts.authorize())break;
    const guard=opts.guard;
    await db.prepare(`INSERT OR IGNORE INTO direct_sources (id,url,kind,name,discovered_at) SELECT ?,?,?,?,?${guard ? ` WHERE ${guard.sql}` : ''}`)
      .bind(crypto.randomUUID(),source.url,source.kind,source.name,now,...(guard?.args() || [])).run();
    const row=await db.prepare('SELECT id FROM direct_sources WHERE url=?').bind(source.url).first<{id:string}>();
    if(row) await db.prepare(`INSERT OR IGNORE INTO direct_source_interests (interest_key,source_id) SELECT ?,?${guard ? ` WHERE ${guard.sql}` : ''}`).bind(key,row.id,...(guard?.args() || [])).run();
  }
  return selected;
}
