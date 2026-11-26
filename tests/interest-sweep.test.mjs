import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {DatabaseSync} from 'node:sqlite';
import {loadDirectRoute,loadInterests,openDatabase} from '../scripts/discovery-runtime.mjs';

const route=await loadDirectRoute(),interests=await loadInterests();
const uni='أخبار وإعلانات جامعة إدلب',other='مواعيد خدمات المياه في حلب';
const context=(request,env)=>({request,env,params:{},waitUntil(){}});
async function setup(){
 const {db,sqlite}=await openDatabase(':memory:');sqlite.exec(await readFile('schema.sql','utf8'));
 for(const [id,chat] of [['a','101'],['b','202']]){
  sqlite.prepare('INSERT INTO subscribers(id,email,telegram_chat_id,status,created_at,magic_token,magic_expires) VALUES(?,?,?,?,?,?,?)').run(id,id+'@example.invalid',chat,'active',new Date().toISOString(),'token-'+id,'2999-01-01T00:00:00.000Z');
  sqlite.prepare('INSERT INTO beta_identities(chat_id,subscriber_id,created_at,created_beta,notifications_enabled_at) VALUES(?,?,?,?,?)').run(chat,id,new Date().toISOString(),1,new Date(Date.now()-60000).toISOString());
 }
 return {db,sqlite,env:{DB:db,CRON_SECRET:'local-only',BETA_ALLOWED_TELEGRAM_IDS:'101,202'}};
}
async function callInterest(env,id,method,text,interestId){
 const req=new Request('https://example.invalid/api/interests',{method,headers:{authorization:'Bearer token-'+id,'content-type':'application/json'},...(method==='GET'?{}:{body:JSON.stringify(method==='PATCH'?{id:interestId,text}:{text})})});
 const response=await ({GET:interests.onRequestGet,POST:interests.onRequestPost,PATCH:interests.onRequestPatch}[method])(context(req,env));return {status:response.status,body:await response.json()};
}
async function sweep(env){const req=new Request('https://example.invalid/api/direct',{method:'POST',headers:{'x-cron-secret':'local-only','content-type':'application/json'},body:JSON.stringify({mode:'sweep'})});const res=await route.onRequestPost(context(req,env));return {status:res.status,body:await res.json()};}
function network({searchStatus=200,networkFailure=false}={}){
 let calls=[],posts=0;const date=new Date().toISOString(),text='تعلن كلية الطب بدء الفصل الدراسي الجديد للطلاب';
 const page=`<meta property="og:title" content="جامعة إدلب"><div class="tgme_widget_message_wrap"><div data-post="IdlebUniversity/123"><div class="tgme_widget_message_text">${text}</div><time datetime="${date}"></time></div></div>`;
 return {calls,get posts(){return posts;},fetch:async input=>{const u=String(input);calls.push(u);if(u.includes('api.telegram.org'))throw Error('real Telegram is forbidden');if(u==='https://t.me/robots.txt')return new Response('',{status:404});if(u==='https://t.me/s/IdlebUniversity')return new Response(page);if(u==='https://t.me/s/IdlebUniversity/123'){posts++;return new Response(page);}if(u.startsWith('https://news.google.com/rss/search')){if(networkFailure)throw Error('mock network failure');return searchStatus===200?new Response('<rss><channel></channel></rss>'):new Response('',{status:searchStatus,headers:{'Retry-After':'3600'}});}throw Error('unexpected network');}};
}

test('new shared interest enters monitoring once, verifies a post and skips duplicate sweeps',async()=>{
 const {sqlite,env}=await setup(),fake=network(),old=globalThis.fetch;globalThis.fetch=fake.fetch;
 try{assert.equal((await callInterest(env,'a','POST',uni)).status,201);assert.equal((await callInterest(env,'b','POST',uni)).status,201);
  assert.equal((await callInterest(env,'a','GET')).body.interests[0].monitoring_status,'pending');
  const first=await sweep(env);assert.equal(first.status,200);assert.equal(first.body.status,'source_linked');assert.equal(first.body.sourceCount,1);assert.equal(first.body.monitored,1);assert.ok(first.body.requests<=12);assert.equal(fake.posts,1);assert.equal(sqlite.prepare('SELECT count(*) n FROM direct_items').get().n,1);
  const calls=fake.calls.length;assert.equal((await sweep(env)).body.checked,0);assert.equal(fake.calls.length,calls);assert.equal(sqlite.prepare('SELECT count(*) n FROM interest_monitor_jobs').get().n,1);assert.equal(sqlite.prepare('SELECT count(*) n FROM notifications').get().n,0);
  const a=(await callInterest(env,'a','GET')).body.interests[0],b=(await callInterest(env,'b','GET')).body.interests[0];assert.equal(a.monitoring_status,'source_linked');assert.ok(a.last_attempt_at);assert.equal(b.monitoring_status,'source_linked');
 }finally{globalThis.fetch=old;sqlite.close();}
});

test('leased sweeps fairly resume a persisted candidate backlog without notifying',async()=>{
 const {sqlite,env}=await setup(),old=globalThis.fetch,date=new Date().toISOString(),ids=Array.from({length:14},(_,i)=>i+100);
 const base=env.DB;let queries=0;env.DB={prepare(sql){const p=base.prepare(sql);return {bind(...args){const q=p.bind(...args);const check=()=>{if(++queries>50)throw Error('D1 Free query limit exceeded');};return {first(){check();return q.first();},all(){check();return q.all();},run(){check();return q.run();}};}};}};
 const post=id=>`<div class="tgme_widget_message_wrap"><div data-post="IdlebUniversity/${id}"><div class="tgme_widget_message_text">إعلان كلية الطب حول الطلاب ${id}</div><time datetime="${date}"></time></div></div>`;
 const head='<meta property="og:title" content="جامعة إدلب">';let botCalls=0;
 globalThis.fetch=async input=>{const u=new URL(String(input));if(u.hostname==='api.telegram.org'){botCalls++;throw Error('bot send forbidden');}if(u.pathname==='/robots.txt')return new Response('',{status:404});if(u.pathname==='/s/IdlebUniversity')return new Response(head+(u.search?'':ids.map(post).join('')));const m=u.pathname.match(/^\/s\/IdlebUniversity\/(\d+)$/);if(m)return new Response(head+post(Number(m[1])));throw Error('unexpected network');};
 try{await callInterest(env,'a','POST',uni);await callInterest(env,'b','POST',uni);queries=0;
  const first=await sweep(env);assert.equal(first.body.outcome,'partial_success');assert.equal(first.body.errorCode,'d1_budget');assert.equal(first.body.diagnostics.pendingCandidates,10);assert.ok(first.body.requests<=12);assert.ok(first.body.diagnostics.dbQueries<=50);
  sqlite.prepare("UPDATE subscribers SET status='paused' WHERE id='a'").run();
  for(let i=0;i<3;i++){sqlite.prepare("UPDATE interest_monitor_jobs SET next_attempt_at='2000-01-01T00:00:00Z'").run();queries=0;const next=await sweep(env);assert.ok(next.body.requests<=12);assert.ok(queries<=50);}
  assert.equal(sqlite.prepare('SELECT COUNT(*) n FROM direct_items').get().n,14);assert.equal(sqlite.prepare("SELECT COUNT(*) n FROM direct_monitor_candidates WHERE status='pending'").get().n,0);
  assert.equal(sqlite.prepare('SELECT COUNT(*) n FROM interest_monitor_jobs').get().n,1);assert.equal(sqlite.prepare('SELECT COUNT(*) n FROM notifications').get().n,0);assert.equal(botCalls,0);
 }finally{globalThis.fetch=old;sqlite.close();}
});

test('rate-limited work remains eligible for a later successful retry',async()=>{
 const {sqlite,env}=await setup(),throttled=network({searchStatus:429}),recovered=network(),old=globalThis.fetch;globalThis.fetch=throttled.fetch;
 try{await callInterest(env,'a','POST',other);assert.equal((await sweep(env)).body.status,'temporary_failure');
  sqlite.prepare("UPDATE interest_monitor_jobs SET next_attempt_at='2000-01-01T00:00:00.000Z'").run();sqlite.prepare("UPDATE direct_provider_backoff SET until_at='2000-01-01T00:00:00.000Z'").run();globalThis.fetch=recovered.fetch;
  const later=await sweep(env);assert.equal(later.body.checked,1);assert.equal(later.body.status,'no_source');assert.ok(recovered.calls.length>0);assert.equal(sqlite.prepare('SELECT count(*) n FROM interest_monitor_jobs').get().n,1);
 }finally{globalThis.fetch=old;sqlite.close();}
});

test('known source remains monitored when optional discovery is rate limited',async()=>{
 const {sqlite,env}=await setup(),fake=network({searchStatus:429}),old=globalThis.fetch,oldLog=console.log,logs=[];
 env.DISCOVERY_EXPAND_LINKED_SOURCES='1';
 globalThis.fetch=fake.fetch;console.log=(...args)=>logs.push(args.join(' '));
 try{await callInterest(env,'a','POST',uni);const result=await sweep(env);
  assert.equal(result.body.status,'source_linked');assert.equal(result.body.outcome,'partial_success');
  assert.equal(result.body.incomplete,true);assert.equal(result.body.errorCode,'rate_limited');assert.equal(result.body.diagnostics.phase,'discovery');
  assert.equal(sqlite.prepare('SELECT count(*) n FROM direct_items').get().n,1);
  assert.equal(sqlite.prepare('SELECT error_code FROM interest_monitor_jobs').get().error_code,'rate_limited');
  assert.ok(logs.every(x=>!x.includes(uni) && !x.includes('local-only') && !x.includes('t.me')));
  const reports=sqlite.prepare('SELECT report FROM direct_runs WHERE report IS NOT NULL').all().map(x=>x.report);
  assert.ok(reports.length>=2);assert.ok(reports.every(x=>!x.includes(uni) && !x.includes('local-only') && !x.includes('t.me')));
 }finally{globalThis.fetch=old;console.log=oldLog;sqlite.close();}
});

test('a stalled optional search preserves verified monitoring and releases the job',async()=>{
 const {sqlite,env}=await setup(),fake=network(),old=globalThis.fetch;
 env.DISCOVERY_EXPAND_LINKED_SOURCES='1';
 globalThis.fetch=async(input,init)=>String(input).startsWith('https://news.google.com/rss/search')?new Promise(()=>{}):fake.fetch(input,init);
 try{await callInterest(env,'a','POST',uni);const result=await sweep(env);
  assert.equal(result.body.outcome,'partial_success');assert.equal(result.body.diagnostics.phase,'discovery');
  assert.equal(result.body.errorCode,'deadline_or_timeout');assert.equal(result.body.incomplete,true);
  assert.equal(sqlite.prepare('SELECT count(*) n FROM direct_items').get().n,1);
  const job=sqlite.prepare('SELECT claim_token,lease_until,next_attempt_at FROM interest_monitor_jobs').get();
  assert.equal(job.claim_token,null);assert.equal(job.lease_until,null);assert.ok(Date.parse(job.next_attempt_at)>Date.now());
 }finally{globalThis.fetch=old;sqlite.close();}
});

test('supported source completes without depending on optional search by default',async()=>{
 const {sqlite,env}=await setup(),fake=network({searchStatus:429}),old=globalThis.fetch;
 globalThis.fetch=fake.fetch;
 try{await callInterest(env,'a','POST',uni);const result=await sweep(env);
  assert.equal(result.body.outcome,'completed');assert.equal(result.body.incomplete,false);
  assert.equal(result.body.discoveryStarted,false);assert.equal(result.body.monitored,1);
  assert.equal(sqlite.prepare('SELECT count(*) n FROM direct_items').get().n,1);
  assert.ok(!fake.calls.some(x=>x.startsWith('https://news.google.com/rss/search')));
 }finally{globalThis.fetch=old;sqlite.close();}
});

test('unknown source is visible, edit is pending, and users only see their own interests',async()=>{
 const {sqlite,env}=await setup(),fake=network(),old=globalThis.fetch;globalThis.fetch=fake.fetch;
 try{await callInterest(env,'a','POST',other);const added=await callInterest(env,'b','POST',uni);
  sqlite.prepare("UPDATE subscriber_interests SET created_at='2020-01-01T00:00:00.000Z' WHERE subscriber_id='a'").run();sqlite.prepare("UPDATE subscriber_interests SET created_at='2020-01-02T00:00:00.000Z' WHERE subscriber_id='b'").run();
  const first=await sweep(env);assert.equal(first.body.status,'no_source');assert.equal(first.body.sourceCount,0);
  const a=(await callInterest(env,'a','GET')).body.interests,b=(await callInterest(env,'b','GET')).body.interests;assert.equal(a.length,1);assert.equal(a[0].text,other);assert.equal(a[0].monitoring_status,'no_source');assert.ok(a[0].last_attempt_at);assert.equal(b[0].monitoring_status,'pending');assert.ok(!JSON.stringify(a).includes(uni));
  assert.equal((await callInterest(env,'b','PATCH','قرارات جامعة إدلب حول الامتحانات',added.body.interest.id)).status,200);assert.equal((await callInterest(env,'b','GET')).body.interests[0].monitoring_status,'pending');
  const second=await sweep(env);assert.equal(second.body.status,'source_linked');assert.equal(sqlite.prepare('SELECT count(*) n FROM interest_monitor_jobs').get().n,2);
 }finally{globalThis.fetch=old;sqlite.close();}
});

test('scheduled cron ticks no longer trigger the interest sweep (isolated from the MVP schedule)',async()=>{
 const {sqlite,env}=await setup(),fake=network(),old=globalThis.fetch;const cron=(await import('../cron-worker/index.js')).default;let directCalls=0;
 globalThis.fetch=async(input,init)=>{const u=String(input);if(u==='https://local.invalid/api/direct'){directCalls++;return route.onRequestPost(context(new Request(u,init),env));}if(u==='https://local.invalid/api/ingest')return new Response('{}');return fake.fetch(input,init);};
 try{await callInterest(env,'a','POST',uni);for(const expression of ['0 1 * * *','7 * * * *','*/30 * * * *']){const pending=[];await cron.scheduled({cron:expression},{SITE_URL:'https://local.invalid',CRON_SECRET:'local-only'},{waitUntil:p=>pending.push(p)});await Promise.all(pending);}assert.equal(directCalls,0);assert.equal(sqlite.prepare('SELECT count(*) n FROM direct_items').get().n,0);assert.equal(sqlite.prepare('SELECT count(*) n FROM interest_monitor_jobs').get().n,0);assert.ok(!fake.calls.some(x=>x.includes('api.telegram.org')));}
 finally{globalThis.fetch=old;sqlite.close();}
});

for(const scenario of [{name:'HTTP 429',options:{searchStatus:429},code:'rate_limited'},{name:'network failure',options:{networkFailure:true},code:'source_or_search_unavailable'}])test(`${scenario.name} retains work with cooldown and does not loop`,async()=>{
 const {sqlite,env}=await setup(),fake=network(scenario.options),old=globalThis.fetch;globalThis.fetch=fake.fetch;
 try{await callInterest(env,'a','POST',other);const result=await sweep(env);assert.equal(result.body.status,'temporary_failure');assert.equal(result.body.errorCode,scenario.code);assert.equal(result.body.incomplete,true);const job=sqlite.prepare('SELECT next_attempt_at,last_attempt_at FROM interest_monitor_jobs').get();assert.ok(job.last_attempt_at);assert.ok(Date.parse(job.next_attempt_at)>Date.now()+24*60000);if(scenario.code==='rate_limited')assert.ok(Date.parse(job.next_attempt_at)>Date.now()+59*60000);const n=fake.calls.length;assert.equal((await sweep(env)).body.checked,0);assert.equal(fake.calls.length,n);assert.equal(sqlite.prepare('SELECT count(*) n FROM interest_monitor_jobs').get().n,1);assert.equal(sqlite.prepare('SELECT count(*) n FROM notifications').get().n,0);
 }finally{globalThis.fetch=old;sqlite.close();}
});

test('paused, non-consenting, uninvited or expired beta accounts do not trigger collection',async()=>{
 const {sqlite,env}=await setup(),fake=network(),old=globalThis.fetch;globalThis.fetch=fake.fetch;
 try{await callInterest(env,'a','POST',uni);sqlite.prepare("UPDATE beta_identities SET notifications_enabled_at=NULL WHERE subscriber_id='a'").run();assert.equal((await sweep(env)).body.checked,0);
  sqlite.prepare("UPDATE beta_identities SET notifications_enabled_at=? WHERE subscriber_id='a'").run(new Date().toISOString());sqlite.prepare("UPDATE subscribers SET status='paused' WHERE id='a'").run();assert.equal((await sweep(env)).body.checked,0);
  sqlite.prepare("UPDATE subscribers SET status='active',expires_at='2000-01-01T00:00:00.000Z' WHERE id='a'").run();assert.equal((await sweep(env)).body.checked,0);
  sqlite.prepare("UPDATE subscribers SET expires_at=NULL WHERE id='a'").run();assert.equal((await sweep({...env,BETA_ALLOWED_TELEGRAM_IDS:'202'})).body.checked,0);assert.equal(fake.calls.length,0);assert.equal(sqlite.prepare('SELECT count(*) n FROM interest_monitor_jobs').get().n,0);
 }finally{globalThis.fetch=old;sqlite.close();}
});

test('overlapping sweeps claim one shared job and never contact the bot API',async()=>{
 const {sqlite,env}=await setup(),fake=network(),old=globalThis.fetch;globalThis.fetch=fake.fetch;
 try{await callInterest(env,'a','POST',uni);await callInterest(env,'b','POST',uni);const results=await Promise.all([sweep(env),sweep(env)]);assert.deepEqual(results.map(x=>x.body.checked).sort(),[0,1]);assert.equal(sqlite.prepare('SELECT count(*) n FROM direct_items').get().n,1);assert.equal(sqlite.prepare('SELECT count(*) n FROM interest_monitor_jobs').get().n,1);assert.ok(!fake.calls.some(x=>x.includes('api.telegram.org')));}
 finally{globalThis.fetch=old;sqlite.close();}
});

test('pausing during robots prevents subsequent source requests and leaves work pending',async()=>{
 const {sqlite,env}=await setup(),old=globalThis.fetch,calls=[];
 globalThis.fetch=async input=>{const u=String(input);calls.push(u);if(u==='https://t.me/robots.txt'){sqlite.prepare("UPDATE subscribers SET status='paused' WHERE id='a'").run();return new Response('',{status:404});}throw Error('a request after pause is forbidden');};
 try{await callInterest(env,'a','POST',uni);const result=await sweep(env);assert.equal(result.body.status,'pending');assert.equal(result.body.errorCode,'eligibility_changed');assert.deepEqual(calls,['https://t.me/robots.txt']);assert.equal(sqlite.prepare('SELECT count(*) n FROM direct_items').get().n,0);const job=sqlite.prepare('SELECT status,next_attempt_at FROM interest_monitor_jobs').get();assert.equal(job.status,'pending');assert.equal(job.next_attempt_at,null);assert.equal(sqlite.prepare('SELECT count(*) n FROM notifications').get().n,0);}
 finally{globalThis.fetch=old;sqlite.close();}
});

test('lost consent before discovery remains pending and does not falsely report no source',async()=>{
 const {db,sqlite,env}=await setup(),old=globalThis.fetch;let calls=0;
 const wrapped={...db,prepare(sql){const p=db.prepare(sql);return {bind(...args){const stmt=p.bind(...args);if(!sql.startsWith('UPDATE direct_runs SET finished_at='))return stmt;return {...stmt,async run(){const result=await stmt.run();sqlite.prepare("UPDATE subscribers SET status='paused' WHERE id='a'").run();return result;}};}};}};
 globalThis.fetch=async()=>{calls++;throw Error('no search is allowed');};
 try{await callInterest(env,'a','POST',other);const result=await sweep({...env,DB:wrapped});assert.equal(result.body.status,'pending');assert.equal(result.body.discoveryStarted,false);assert.equal(result.body.errorCode,'eligibility_changed');assert.equal(calls,0);const job=sqlite.prepare('SELECT status,next_attempt_at,last_discovery_at FROM interest_monitor_jobs').get();assert.equal(job.status,'pending');assert.equal(job.next_attempt_at,null);assert.equal(job.last_discovery_at,null);}
 finally{globalThis.fetch=old;sqlite.close();}
});

test('pausing during permalink fetch fences the subsequent content write',async()=>{
 const {sqlite,env}=await setup(),old=globalThis.fetch,date=new Date().toISOString();let calls=0;
 const page=`<meta property="og:title" content="جامعة إدلب"><div class="tgme_widget_message_wrap"><div data-post="IdlebUniversity/123"><div class="tgme_widget_message_text">تعلن كلية الطب بدء الفصل الدراسي الجديد للطلاب</div><time datetime="${date}"></time></div></div>`;
 globalThis.fetch=async input=>{calls++;const u=String(input);if(u==='https://t.me/robots.txt')return new Response('',{status:404});if(u==='https://t.me/s/IdlebUniversity')return new Response(page);if(u==='https://t.me/s/IdlebUniversity/123'){sqlite.prepare("UPDATE subscribers SET status='paused' WHERE id='a'").run();return new Response(page);}throw Error('no further requests allowed');};
 try{await callInterest(env,'a','POST',uni);const result=await sweep(env);assert.equal(result.body.status,'pending');assert.equal(result.body.errorCode,'eligibility_changed');assert.equal(calls,3);assert.equal(sqlite.prepare('SELECT count(*) n FROM direct_items').get().n,0);assert.equal(sqlite.prepare('SELECT count(*) n FROM notifications').get().n,0);}
 finally{globalThis.fetch=old;sqlite.close();}
});

test('consent changing immediately before job commit cannot produce no_source',async()=>{
 const {db,sqlite,env}=await setup(),fake=network(),old=globalThis.fetch;globalThis.fetch=fake.fetch;let paused=false;
 const wrapped={...db,prepare(sql){const p=db.prepare(sql);return {bind(...args){const stmt=p.bind(...args);if(!sql.startsWith('UPDATE interest_monitor_jobs SET status=?'))return stmt;return {...stmt,async run(){if(!paused){paused=true;sqlite.prepare("UPDATE subscribers SET status='paused' WHERE id='a'").run();}return stmt.run();}};}};}};
 try{await callInterest(env,'a','POST',other);const result=await sweep({...env,DB:wrapped});assert.equal(result.body.status,'pending');assert.equal(result.body.errorCode,'eligibility_changed');const job=sqlite.prepare('SELECT status,next_attempt_at,last_discovery_at FROM interest_monitor_jobs').get();assert.equal(job.status,'pending');assert.equal(job.next_attempt_at,null);assert.equal(job.last_discovery_at,null);}
 finally{globalThis.fetch=old;sqlite.close();}
});

test('expired lease fences stale search results and stale completion',async()=>{
 const {sqlite,env}=await setup(),old=globalThis.fetch;let count=0,release,start;const started=new Promise(r=>start=r),hold=new Promise(r=>release=r);
 const rss=host=>`<rss><item><title>مواعيد خدمات المياه في حلب</title><link>https://${host}/article</link><source url="https://${host}">مصدر</source></item></rss>`;
 globalThis.fetch=async input=>{const u=String(input);assert.ok(u.startsWith('https://news.google.com/rss/search'));count++;if(count===1){start();await hold;return new Response(rss('old.example'));}return new Response(rss('new.example'));};
 try{await callInterest(env,'a','POST',other);const first=sweep(env);await started;sqlite.prepare("UPDATE interest_monitor_jobs SET lease_until='2000-01-01T00:00:00.000Z'").run();const second=await sweep(env);release();const stale=await first;assert.equal(count,2);assert.equal(second.body.status,'source_linked');assert.equal(stale.body.status,'claim_lost');assert.equal(stale.body.checked,0);assert.equal(sqlite.prepare("SELECT count(*) n FROM direct_sources WHERE url='https://old.example'").get().n,0);assert.equal(sqlite.prepare("SELECT count(*) n FROM direct_sources WHERE url='https://new.example'").get().n,1);assert.equal(sqlite.prepare('SELECT status FROM interest_monitor_jobs').get().status,'source_linked');}
 finally{globalThis.fetch=old;sqlite.close();}
});

test('shared work uses the currently eligible owner text after the original owner pauses',async()=>{
 const {sqlite,env}=await setup(),old=globalThis.fetch,queries=[];const alternate='اخبار واعلانات جامعه ادلب';
 env.DISCOVERY_EXPAND_LINKED_SOURCES='1';
 assert.equal(interests.normalizeInterest(uni),interests.normalizeInterest(alternate));
 globalThis.fetch=async input=>{const u=String(input);if(u==='https://t.me/robots.txt')return new Response('',{status:404});if(u==='https://t.me/s/IdlebUniversity')return new Response('<meta property="og:title" content="جامعة إدلب">');if(u.startsWith('https://news.google.com/rss/search')){queries.push(new URL(u).searchParams.get('q'));return new Response('<rss></rss>');}throw Error('unexpected network');};
 try{await callInterest(env,'a','POST',uni);await callInterest(env,'b','POST',alternate);sqlite.prepare("UPDATE subscriber_interests SET created_at='2020-01-01' WHERE subscriber_id='a'").run();assert.equal((await sweep(env)).body.status,'source_linked');sqlite.prepare("UPDATE subscribers SET status='paused' WHERE id='a'").run();sqlite.prepare("UPDATE interest_monitor_jobs SET next_attempt_at='2000-01-01',last_discovery_at=NULL").run();assert.equal((await sweep(env)).body.status,'source_linked');assert.equal(queries.length,2);assert.ok(queries[1].startsWith(alternate));const job=sqlite.prepare('SELECT interest_key,interest_text FROM interest_monitor_jobs').get();assert.equal(job.interest_text,job.interest_key);}
 finally{globalThis.fetch=old;sqlite.close();}
});

test('shared work stops when its selected owner pauses, then retries for the other eligible owner',async()=>{
 const {sqlite,env}=await setup(),old=globalThis.fetch,fake=network();let paused=false;const calls=[];
 globalThis.fetch=async(input,init)=>{const u=String(input);calls.push(u);if(u==='https://t.me/robots.txt' && !paused){paused=true;sqlite.prepare("UPDATE subscribers SET status='paused' WHERE id='a'").run();return new Response('',{status:404});}return fake.fetch(input,init);};
 try{await callInterest(env,'a','POST',uni);await callInterest(env,'b','POST',uni);sqlite.prepare("UPDATE subscriber_interests SET created_at='2020-01-01' WHERE subscriber_id='a'").run();const first=await sweep(env);assert.equal(first.body.status,'pending');assert.equal(first.body.errorCode,'eligibility_changed');assert.deepEqual(calls,['https://t.me/robots.txt']);const second=await sweep(env);assert.equal(second.body.status,'source_linked');assert.equal(sqlite.prepare('SELECT count(*) n FROM direct_items').get().n,1);assert.equal(sqlite.prepare('SELECT count(*) n FROM interest_monitor_jobs').get().n,1);assert.ok(!calls.some(x=>x.includes('api.telegram.org')));}
 finally{globalThis.fetch=old;sqlite.close();}
});

test('linked legacy beta identity also needs explicit consent and invitation',async()=>{
 const {sqlite,env}=await setup(),fake=network(),old=globalThis.fetch;globalThis.fetch=fake.fetch;
 try{await callInterest(env,'a','POST',other);sqlite.prepare("UPDATE beta_identities SET created_beta=0,notifications_enabled_at=NULL WHERE subscriber_id='a'").run();assert.equal((await sweep(env)).body.checked,0);sqlite.prepare("UPDATE beta_identities SET notifications_enabled_at=? WHERE subscriber_id='a'").run(new Date().toISOString());assert.equal((await sweep({...env,BETA_ALLOWED_TELEGRAM_IDS:'202'})).body.checked,0);assert.equal(fake.calls.length,0);assert.equal((await sweep(env)).body.status,'no_source');}
 finally{globalThis.fetch=old;sqlite.close();}
});

test('migration 0012 upgrades 0011 data without loss and enforces its job constraints',async()=>{
 const sqlite=new DatabaseSync(':memory:');try{
  sqlite.exec('PRAGMA foreign_keys=ON');sqlite.exec(await readFile('schema.sql','utf8'));
  for(const file of ['0001_discovery.sql','0002_discovery_provenance.sql','0003_direct_sources.sql','0004_subscriber_interests.sql','0005_discovery_mock_flag.sql','0006_notifications.sql','0007_telegram_link_tokens.sql','0008_notification_delivery_claim.sql','0009_direct_verification.sql','0010_beta_auth.sql','0011_beta_delivery.sql'])sqlite.exec(await readFile('migrations/'+file,'utf8'));
  sqlite.prepare('INSERT INTO subscribers(id,email,status,created_at) VALUES(?,?,?,?)').run('s','old@example.invalid','active','2020-01-01');sqlite.prepare('INSERT INTO subscriber_interests(id,subscriber_id,text,normalized_text,created_at,updated_at) VALUES(?,?,?,?,?,?)').run('i','s','old interest','old interest','2020-01-01','2020-01-01');
  const migration=await readFile('migrations/0012_interest_monitor_jobs.sql','utf8');sqlite.exec(migration);sqlite.exec(migration);
  assert.equal(sqlite.prepare('SELECT count(*) n FROM subscribers').get().n,1);assert.equal(sqlite.prepare('SELECT count(*) n FROM subscriber_interests').get().n,1);assert.ok(sqlite.prepare("SELECT name FROM sqlite_master WHERE type='index' AND name='idx_interest_monitor_due'").get());
  sqlite.prepare('INSERT INTO interest_monitor_jobs(interest_key,interest_text,created_at,updated_at) VALUES(?,?,?,?)').run('k','k','2020-01-01','2020-01-01');assert.equal(sqlite.prepare('SELECT status FROM interest_monitor_jobs').get().status,'pending');assert.throws(()=>sqlite.prepare("UPDATE interest_monitor_jobs SET status='invalid'").run());assert.throws(()=>sqlite.prepare('INSERT INTO interest_monitor_jobs(interest_key,interest_text,created_at,updated_at) VALUES(?,?,?,?)').run('k','k','2020-01-01','2020-01-01'));assert.equal(sqlite.prepare('PRAGMA foreign_key_check').all().length,0);
 }finally{sqlite.close();}
});

// Workers Free permits 50 D1 queries per invocation. The sweep stops starting new
// source work at 36 and this test pins the full-invocation total (route handler,
// claim, monitoring, persistence and finalization together) at 45 or fewer, so at
// least five queries of headroom remain even with a larger deferred backlog.
test('a larger 20-post backlog drains within a safe D1 query margin on every full invocation',async()=>{
 const {sqlite,env}=await setup(),old=globalThis.fetch,date=new Date().toISOString(),ids=Array.from({length:20},(_,i)=>i+100);
 const base=env.DB;let queries=0;env.DB={prepare(sql){const p=base.prepare(sql);return {bind(...args){const q=p.bind(...args);const check=()=>{if(++queries>50)throw Error('D1 Free query limit exceeded');};return {first(){check();return q.first();},all(){check();return q.all();},run(){check();return q.run();}};}};}};
 const post=id=>`<div class="tgme_widget_message_wrap"><div data-post="IdlebUniversity/${id}"><div class="tgme_widget_message_text">إعلان كلية الطب حول الطلاب ${id}</div><time datetime="${date}"></time></div></div>`;
 const head='<meta property="og:title" content="جامعة إدلب">';let botCalls=0;
 globalThis.fetch=async input=>{const u=new URL(String(input));if(u.hostname==='api.telegram.org'){botCalls++;throw Error('bot send forbidden');}if(u.pathname==='/robots.txt')return new Response('',{status:404});if(u.pathname==='/s/IdlebUniversity')return new Response(head+(u.search?'':ids.map(post).join('')));const m=u.pathname.match(/^\/s\/IdlebUniversity\/(\d+)$/);if(m)return new Response(head+post(Number(m[1])));throw Error('unexpected network');};
 try{await callInterest(env,'a','POST',uni);await callInterest(env,'b','POST',uni);queries=0;
  const first=await sweep(env);assert.equal(first.status,200);
  assert.equal(first.body.outcome,'partial_success');assert.equal(first.body.errorCode,'d1_budget');
  assert.ok(first.body.diagnostics.dbQueries<=45,`first sweep used ${first.body.diagnostics.dbQueries} D1 queries`);
  assert.ok(queries<=45,`full invocation used ${queries} D1 queries`);
  assert.ok(first.body.requests<=12);
  assert.equal(first.body.diagnostics.pendingCandidates,16);
  assert.equal(sqlite.prepare('SELECT COUNT(*) n FROM direct_monitor_candidates').get().n,20);
  // A tester pausing mid-drain must not stall the shared backlog for the other owner.
  sqlite.prepare("UPDATE subscribers SET status='paused' WHERE id='a'").run();
  for(let i=0;i<5;i++){
   sqlite.prepare("UPDATE interest_monitor_jobs SET next_attempt_at='2000-01-01T00:00:00Z'").run();queries=0;
   const next=await sweep(env);assert.ok(next.body.requests<=12);
   if(next.body.checked===1){assert.ok(next.body.diagnostics.dbQueries<=45,`sweep ${i+2} used ${next.body.diagnostics.dbQueries} D1 queries`);}
   assert.ok(queries<=45,`full invocation ${i+2} used ${queries} D1 queries`);
  }
  assert.equal(sqlite.prepare('SELECT COUNT(*) n FROM direct_items').get().n,20);
  assert.equal(sqlite.prepare("SELECT COUNT(*) n FROM direct_items WHERE verification_status='telegram_post_verified'").get().n,20);
  assert.equal(sqlite.prepare("SELECT COUNT(*) n FROM direct_monitor_candidates WHERE status='pending'").get().n,0);
  assert.equal(sqlite.prepare('SELECT COUNT(*) n FROM direct_items').get().n,sqlite.prepare('SELECT COUNT(DISTINCT url) n FROM direct_items').get().n);
  assert.equal(sqlite.prepare('SELECT COUNT(*) n FROM notifications').get().n,0);assert.equal(botCalls,0);
 }finally{globalThis.fetch=old;sqlite.close();}
});
