// Public-source acceptance through the actual leased sweep and its budgets.
// Reference URLs are read only after all sweeps. The fake subscriber and D1
// exist only in memory; Bot API is forbidden and baselines are never changed.
import {build} from 'esbuild';import {readFile} from 'node:fs/promises';import {openDatabase} from './discovery-runtime.mjs';
const load=async path=>{const b=await build({entryPoints:[path],bundle:true,platform:'neutral',format:'esm',write:false});return import('data:text/javascript;base64,'+Buffer.from(b.outputFiles[0].contents).toString('base64'));};
const {runInterestSweep}=await load('functions/api/_interest_monitor.ts'),engine=await load('functions/api/_discovery.ts'),direct=await load('functions/api/_direct.ts'),ingest=await load('functions/api/_ingest.ts');
const originalLog=console.log;console.log=(...args)=>{if(args[0]!=='interest_sweep')originalLog(...args);};
const interests=['أخبار وإعلانات جامعة إدلب','آخر أخبار وإعلانات وزارة التعليم العالي','مشاريع الخدمات والبنية التحتية في إدلب'],results=[],started=new Date().toISOString();
for(const interest of interests){
 const {db,sqlite}=await openDatabase(':memory:');sqlite.exec(await readFile('schema.sql','utf8'));const key=engine.normalize(interest),observed=new Map(),cycles=[];
 sqlite.prepare('INSERT INTO subscribers(id,email,status,telegram_chat_id,created_at) VALUES(?,?,?,?,?)').run('local','local@example.invalid','active','101',started);
 sqlite.prepare('INSERT INTO beta_identities(chat_id,subscriber_id,created_at,created_beta,notifications_enabled_at) VALUES(?,?,?,?,?)').run('101','local',started,1,started);
 sqlite.prepare('INSERT INTO subscriber_interests(id,subscriber_id,text,normalized_text,created_at,updated_at) VALUES(?,?,?,?,?,?)').run('i','local',interest,key,started,started);
 const fetcher=async(input,init)=>{const u=new URL(String(input));if(u.hostname==='api.telegram.org')throw Error('Bot API forbidden');const response=await fetch(input,init);
  if(response.ok && ((u.hostname==='t.me' && /^\/s\/[A-Za-z0-9_]+$/.test(u.pathname)) || (u.hostname==='sana.sy' && u.pathname.endsWith('/feed/')))){
   const body=await response.clone().text();if(u.hostname==='t.me')for(const p of direct.parseTelegram(body,u.origin+u.pathname))observed.set(p.url,true);else for(const p of ingest.parseFeed(body,40))observed.set(p.link,true);
  }return response;};
 try{for(let i=0;i<4;i++){
   // Only advance the isolated scheduler's due time; do not alter notification baselines or provider cooldowns.
   if(i)sqlite.prepare("UPDATE interest_monitor_jobs SET next_attempt_at='2000-01-01T00:00:00Z'").run();
   const result=await runInterestSweep(db,{DB:db,BETA_ALLOWED_TELEGRAM_IDS:'101',STAGING_PILOT_MODE:'1',TELEGRAM_DELIVERY_ENABLED:'0'},fetcher);cycles.push(result);
   if(result.errorCode==='rate_limited'||result.errorCode==='deadline_or_timeout')break;
  }
  const items=sqlite.prepare("SELECT url,title,published_at,first_seen,verification_status FROM direct_items WHERE verification_status IN ('telegram_post_verified','publisher_title_match')").all();
  const queued=sqlite.prepare('SELECT url,status,last_error FROM direct_monitor_candidates WHERE interest_key=?').all(key);
  results.push({interest,cycles,items,observed:[...observed.keys()],queued});
 }finally{sqlite.close();}
}
const reference=JSON.parse(await readFile(process.argv[2]||'tests/fixtures/reliability-sweep-reference.json','utf8'));
for(const r of results){const events=reference.cases.find(c=>c.interest===r.interest)?.events||[],seen=new Set(r.observed),queue=new Map(r.queued.map(q=>[q.url,q]));
 const checked=events.map(e=>{const item=r.items.find(x=>x.url.replace(/\/$/,'')===e.url.replace(/\/$/,'')),fetched=seen.has(e.url)||seen.has(e.url.replace(/\/$/,'')+'/'),q=queue.get(e.url)||queue.get(e.url.replace(/\/$/,'')+'/');
  return {...e,accepted:!!item,fetched,candidateState:q?.status||null,classification:item?'verified':q?.status==='pending'||q?.status==='failed'?'verification_deferred':fetched?'fetched_not_accepted':'not_fetched',within72h:!!e.publishedAt&&Date.parse(e.publishedAt)>=Date.parse(started)-72*3600000,publishedBeforeNewSubscriber:!!e.publishedAt&&Date.parse(e.publishedAt)<=Date.parse(started)};});
 delete r.observed;delete r.queued;console.log(JSON.stringify({...r,references:checked,started}));
}
