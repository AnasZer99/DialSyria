// Genuine public-source acceptance; reference URLs are loaded only after all
// monitoring calls. SQLite is in memory; no Bot API or remote D1 is accessed.
import {build} from 'esbuild';
import {readFile} from 'node:fs/promises';
import {openDatabase} from './discovery-runtime.mjs';
const load=async path=>{const b=await build({entryPoints:[path],bundle:true,platform:'neutral',format:'esm',write:false});return import('data:text/javascript;base64,'+Buffer.from(b.outputFiles[0].contents).toString('base64'));};
const direct=await load('functions/api/_direct.ts'),catalog=await load('functions/api/_source_catalog.ts'),engine=await load('functions/api/_discovery.ts'),ingest=await load('functions/api/_ingest.ts'),{createLiveBudget}=await load('functions/api/_live_budget.ts');
const interests=['أخبار وإعلانات جامعة إدلب','آخر أخبار وإعلانات وزارة التعليم العالي','مشاريع الخدمات والبنية التحتية في إدلب'];
const {db,sqlite}=await openDatabase(':memory:');sqlite.exec(await readFile('schema.sql','utf8'));
const results=[],started=new Date().toISOString();
try {
 for(const interest of interests){
  await catalog.attachCandidateSources(db,interest);const observed=new Map(),cycles=[],items=new Map();
  for(let cycle=0;cycle<4;cycle++){
   const fetcher=async(input,init)=>{const u=new URL(String(input));if(u.hostname==='api.telegram.org')throw Error('Bot API forbidden');const response=await fetch(input,init);
    if(response.ok && ((u.hostname==='t.me' && /^\/s\/[A-Za-z0-9_]+$/.test(u.pathname)) || (u.hostname==='sana.sy' && u.pathname.endsWith('/feed/')))){
     const body=await response.clone().text();
     if(u.hostname==='t.me'){for(const p of direct.parseTelegram(body,u.origin+u.pathname))observed.set(p.url,{title:p.text.slice(0,180),content:p.text,publishedAt:p.publishedAt});}
     else for(const p of ingest.parseFeed(body,40))observed.set(p.link,{title:p.title,content:p.description||'',publishedAt:p.pubDate?new Date(p.pubDate).toISOString():null});
    }return response;};
   const budget=createLiveBudget(fetcher,15000,12,2500);
   const r=await direct.monitorDirectSources(db,interest,{fetcher:budget.fetcher,shouldStop:budget.exhausted,durable:true});
   for(const item of r.items)items.set(item.url,item);
   cycles.push({requests:budget.requests(),incomplete:r.incomplete,observations:r.observations,errors:r.errors});
  }
  const queued=await db.prepare('SELECT url,status,last_error,first_seen FROM direct_monitor_candidates WHERE interest_key=?').bind(engine.normalize(interest)).all();
  results.push({interest,cycles,items:[...items.values()],observed:[...observed.entries()],queued:queued.results});
 }
 const reference=JSON.parse(await readFile(process.argv[2]||'tests/fixtures/reliability-independent.json','utf8'));
 for(const r of results){const samples=reference.cases.find(c=>c.interest===r.interest)?.events||[];const seen=new Map(r.observed),queue=new Map(r.queued.map(q=>[q.url,q]));
  const checked=samples.map(e=>{const item=r.items.find(x=>x.url.replace(/\/$/,'')===e.url.replace(/\/$/,''));const entry=seen.get(e.url)||seen.get(e.url.replace(/\/$/,'')+'/');const q=queue.get(e.url)||queue.get(e.url.replace(/\/$/,'')+'/');
   return {...e,accepted:!!item,fetched:!!entry,candidateState:q?.status||null,classification:item?'verified':q?.status==='pending'||q?.status==='failed'?'verification_deferred':entry?'fetched_not_accepted':'not_fetched',within72h:!!e.publishedAt&&Date.parse(e.publishedAt)>=Date.parse(started)-72*3600000,publishedBeforeNewSubscriber:!!e.publishedAt&&Date.parse(e.publishedAt)<=Date.parse(started)};});
  delete r.observed;delete r.queued;console.log(JSON.stringify({...r,references:checked,started}));
 }
}finally{sqlite.close();}
