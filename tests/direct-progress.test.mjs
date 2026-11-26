import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {DatabaseSync} from 'node:sqlite';
import {loadDirect,loadEngine,loadNotify,openDatabase} from '../scripts/discovery-runtime.mjs';

const direct=await loadDirect(),engine=await loadEngine(),notify=await loadNotify();
const interest='أخبار وإعلانات جامعة إدلب',key=engine.normalize(interest),channel='https://t.me/s/IdlebUniversity';
const date=new Date().toISOString(),head='<meta property="og:title" content="جامعة إدلب">';
const post=id=>`<div class="tgme_widget_message_wrap"><div data-post="IdlebUniversity/${id}"><div class="tgme_widget_message_text">تعلن كلية الطب عن لقاء أكاديمي للطلاب رقم ${id}</div><time datetime="${date}"></time></div></div>`;
async function setup(){const {db,sqlite}=await openDatabase(':memory:');sqlite.exec(await readFile('schema.sql','utf8'));sqlite.prepare('INSERT INTO direct_sources(id,url,kind,name,discovered_at) VALUES(?,?,?,?,?)').run('source',channel,'telegram','جامعة إدلب',date);sqlite.prepare('INSERT INTO direct_source_interests(interest_key,source_id) VALUES(?,?)').run(key,'source');return {db,sqlite};}
function source(){
 let current=[100,101,102,103,104],pages={},throttle=false,throttleDetail=false,failDetail=false;const calls=[];
 const fetcher=async input=>{const u=new URL(String(input));calls.push(u.toString());if(u.hostname==='api.telegram.org')throw Error('bot send forbidden');if(u.pathname==='/robots.txt')return new Response('',{status:404});
  if(u.pathname==='/s/IdlebUniversity'){const before=u.searchParams.get('before');if(before&&throttle)return new Response('',{status:429,headers:{'Retry-After':'600'}});const ids=before?(pages[before]||[]):current;return new Response(head+ids.map(post).join(''));}
  const match=u.pathname.match(/^\/s\/IdlebUniversity\/(\d+)$/);if(match){if(throttleDetail)return new Response('',{status:429,headers:{'Retry-After':'600'}});if(failDetail)throw Error('local network failure');return new Response(head+post(Number(match[1])));}throw Error('unexpected network');};
 return {calls,fetcher,setCurrent:x=>current=x,setPages:x=>pages=x,setThrottle:x=>throttle=x,setThrottleDetail:x=>throttleDetail=x,setFailDetail:x=>failDetail=x};
}
const monitor=(db,fake,extra={})=>direct.monitorDirectSources(db,interest,{fetcher:fake.fetcher,durable:true,...extra});

test('durable catch-up resumes a gap larger than the current page, fairly drains and deduplicates',async()=>{
 const {db,sqlite}=await setup(),fake=source();
 try{
  const first=await monitor(db,fake);assert.equal(first.observations[0].verified,4);assert.equal(first.observations[0].unprocessed,1);
  assert.equal(sqlite.prepare('SELECT COUNT(*) n FROM direct_items').get().n,4);
  await monitor(db,fake);assert.equal(sqlite.prepare('SELECT next_before FROM direct_monitor_cursors').get().next_before,null);
  fake.setCurrent([110,111,112,113,114,115,116]);fake.setPages({'110':[104,105,106,107,108,109]});
  const burst=await monitor(db,fake);assert.equal(burst.observations[0].paginationPending,true);
  const cursor=sqlite.prepare('SELECT next_before,stop_after FROM direct_monitor_cursors').get();assert.equal(cursor.next_before,'110');assert.equal(cursor.stop_after,'104');
  const previous=await monitor(db,fake);assert.ok(previous.observations[0].accepted>0);assert.equal(sqlite.prepare('SELECT next_before FROM direct_monitor_cursors').get().next_before,null);
  for(let i=0;i<3;i++)await monitor(db,fake);
  for(const id of [105,106,107,108,109,110,111,112,113,114,115,116])assert.ok(sqlite.prepare('SELECT id FROM direct_items WHERE url=?').get(`https://t.me/IdlebUniversity/${id}`),`missing ${id}`);
  assert.equal(sqlite.prepare('SELECT COUNT(*) n FROM direct_monitor_candidates WHERE status=\'pending\'').get().n,0);
  assert.equal(sqlite.prepare('SELECT COUNT(*) n FROM direct_items').get().n,sqlite.prepare('SELECT COUNT(DISTINCT url) n FROM direct_items').get().n);
  assert.equal(fake.calls.filter(x=>x.includes('before=110')).length,1);assert.ok(!fake.calls.some(x=>x.includes('api.telegram.org')));
 }finally{sqlite.close();}
});

test('candidate batches remain usable when D1 rejects compound SELECTs over four terms',async()=>{
 const {db,sqlite}=await setup(),fake=source();fake.setCurrent(Array.from({length:12},(_,i)=>i+100));
 const limited={prepare(sql){if(sql.includes('direct_monitor_candidates') && (sql.match(/\bUNION\s+ALL\b/gi)||[]).length>=4)throw Error('too many terms in compound SELECT');return db.prepare(sql);}};
 try{const result=await monitor(limited,fake);assert.equal(result.observations[0].verified,4);assert.equal(sqlite.prepare('SELECT COUNT(*) n FROM direct_monitor_candidates').get().n,12);assert.equal(result.observations[0].unprocessed,8);}
 finally{sqlite.close();}
});

test('a rate-limited permalink stays unprocessed and resumes after provider cooldown',async()=>{
 const {db,sqlite}=await setup(),fake=source();fake.setCurrent([101]);fake.setThrottleDetail(true);
 try{const first=await monitor(db,fake);assert.equal(first.observations[0].rejected,0);assert.equal(first.observations[0].unprocessed,1);
  assert.deepEqual({...sqlite.prepare('SELECT status,attempts,last_error FROM direct_monitor_candidates').get()},{status:'pending',attempts:0,last_error:'rate_limited'});
  const calls=fake.calls.length;await monitor(db,fake);assert.equal(fake.calls.length,calls);
  sqlite.prepare("UPDATE direct_provider_backoff SET until_at='2000-01-01T00:00:00Z'").run();sqlite.prepare("UPDATE direct_monitor_candidates SET next_attempt_at='2000-01-01T00:00:00Z'").run();fake.setThrottleDetail(false);
  await monitor(db,fake);assert.equal(sqlite.prepare('SELECT status FROM direct_monitor_candidates').get().status,'verified');assert.equal(sqlite.prepare('SELECT COUNT(*) n FROM direct_items').get().n,1);
 }finally{sqlite.close();}
});

test('failure of one source does not prevent an independent known source from being verified',async()=>{
 const {db,sqlite}=await setup(),fake=source();
 sqlite.prepare('INSERT INTO direct_sources(id,url,kind,name,discovered_at) VALUES(?,?,?,?,?)').run('site','https://sana.sy/governorates/edlib','website','سانا',date);
 sqlite.prepare('INSERT INTO direct_source_interests(interest_key,source_id) VALUES(?,?)').run(key,'site');
 sqlite.prepare("UPDATE direct_source_interests SET last_checked_at='2000-01-01T00:00:00Z' WHERE source_id='site'").run();
 const fetcher=async(input,init)=>String(input).startsWith('https://sana.sy/')?new Response('',{status:503}):fake.fetcher(input,init);
 try{const result=await direct.monitorDirectSources(db,interest,{durable:true,fetcher});assert.equal(result.observations.length,2);assert.ok(result.errors.length);assert.ok(result.items.some(item=>item.verification==='telegram_post_verified'));assert.equal(sqlite.prepare("SELECT COUNT(*) n FROM direct_items WHERE source_id='source'").get().n,4);}
 finally{sqlite.close();}
});

test('pagination 429 retains cursor and pending candidates without a request loop',async()=>{
 const {db,sqlite}=await setup(),fake=source();
 try{await monitor(db,fake);const before=sqlite.prepare('SELECT next_before FROM direct_monitor_cursors').get().next_before;assert.ok(before);
  fake.setThrottle(true);const limited=await monitor(db,fake);assert.equal(limited.incomplete,true);assert.equal(sqlite.prepare('SELECT next_before FROM direct_monitor_cursors').get().next_before,before);assert.equal(limited.observations[0].unprocessed,1);
  const count=fake.calls.length;await monitor(db,fake);assert.equal(fake.calls.length,count);
  sqlite.prepare("UPDATE direct_provider_backoff SET until_at='2000-01-01T00:00:00Z'").run();fake.setThrottle(false);
  await monitor(db,fake);assert.equal(sqlite.prepare('SELECT next_before FROM direct_monitor_cursors').get().next_before,null);assert.equal(sqlite.prepare("SELECT COUNT(*) n FROM direct_monitor_candidates WHERE status='pending'").get().n,0);
 }finally{sqlite.close();}
});

test('interruption during candidate persistence does not advance the cursor or lose work',async()=>{
 const {db,sqlite}=await setup(),fake=source();let checks=0;fake.setCurrent([100,101,102,103,104,105,106,107,108,109]);
 try{const interrupted=await monitor(db,fake,{authorize:async()=>++checks<3});assert.equal(interrupted.incomplete,true);assert.equal(sqlite.prepare('SELECT COUNT(*) n FROM direct_monitor_cursors').get().n,0);
  const firstSeen=sqlite.prepare('SELECT first_seen FROM direct_monitor_candidates LIMIT 1').get()?.first_seen;
  assert.equal(sqlite.prepare('SELECT COUNT(*) n FROM direct_monitor_candidates').get().n,8);
  await monitor(db,fake);assert.equal(sqlite.prepare('SELECT COUNT(*) n FROM direct_monitor_candidates').get().n,10);
  if(firstSeen)assert.equal(sqlite.prepare('SELECT first_seen FROM direct_monitor_candidates ORDER BY first_seen LIMIT 1').get().first_seen,firstSeen);
  await monitor(db,fake);await monitor(db,fake);assert.equal(sqlite.prepare('SELECT COUNT(*) n FROM direct_items').get().n,10);
 }finally{sqlite.close();}
});

test('failed verification is retained with a bounded retry and later recovers',async()=>{
 const {db,sqlite}=await setup(),fake=source();fake.setCurrent([101]);fake.setFailDetail(true);
 try{for(let i=0;i<3;i++){await monitor(db,fake);sqlite.prepare("UPDATE direct_monitor_candidates SET next_attempt_at='2000-01-01T00:00:00Z' WHERE status='pending'").run();}
  const failed=sqlite.prepare('SELECT status,attempts,next_attempt_at FROM direct_monitor_candidates').get();assert.equal(failed.status,'failed');assert.equal(failed.attempts,3);assert.ok(Date.parse(failed.next_attempt_at)>Date.now()+5*3600000);
  fake.setFailDetail(false);await monitor(db,fake);assert.equal(sqlite.prepare('SELECT COUNT(*) n FROM direct_items').get().n,0);
  sqlite.prepare("UPDATE direct_monitor_candidates SET next_attempt_at='2000-01-01T00:00:00Z' WHERE status='failed'").run();await monitor(db,fake);assert.equal(sqlite.prepare('SELECT status FROM direct_monitor_candidates').get().status,'verified');assert.equal(sqlite.prepare('SELECT COUNT(*) n FROM direct_items').get().n,1);
 }finally{sqlite.close();}
});

test('equivalent infrastructure forms need the same location and action, and old observations cannot notify',()=>{
 const candidate=(title,description)=>({title,description,url:'https://sana.sy/a',source:'سانا',publishedAt:date,provider:'direct'});
 const q='مشاريع الخدمات والبنية التحتية في إدلب';
 assert.equal(engine.evaluateDirect(q,candidate('تقييم الأضرار في حاس بريف إدلب','بدأ تقييم شبكات البنية التحتية تمهيداً لترميمها')).accepted,true);
 assert.equal(engine.evaluateDirect(q,candidate('تقييم الأضرار في حاس بريف إدلب','بدأ تقييم شبكات بنية تحتية تمهيداً لترميمها')).accepted,true);
 assert.equal(engine.evaluateDirect(q,candidate('تقييم الأضرار في حاس بريف إدلب','بدأ تقييم البنى التحتية تمهيداً لترميمها')).accepted,true);
 assert.equal(engine.evaluateDirect(q,candidate('تقييم الأضرار في حاس بريف إدلب','بدأ العمل بالبنية التحتية تمهيداً لترميمها')).accepted,true);
 assert.equal(engine.evaluateDirect(q,candidate('تقييم الأضرار في حلب','بدأ تقييم شبكات البنية التحتية تمهيداً لترميمها')).accepted,false);
 assert.equal(engine.evaluateDirect(q,candidate('أخبار إدلب','نقاش عام عن البنية التحتية')).accepted,false);
 assert.equal(engine.evaluateDirect(q,candidate('ترميم منزل في إدلب','أعلنت العائلة ترميم منزلها')).accepted,false);
 const ministry='أخبار وإعلانات وزارة التعليم العالي',context={institution:'higher_education_ministry'};
 assert.equal(engine.evaluateDirect(ministry,candidate('زيارة الوفد إلى الجامع الأموي في دمشق','لقطات من زيارة الجامع الأموي'),Date.now(),context).accepted,false);
 assert.equal(engine.evaluateDirect(ministry,candidate('مستجدات الجامعات','أعلنت الجامعة موعد التسجيل للطلاب'),Date.now(),context).accepted,true);
 const now=Date.now(),baseline=new Date(now-3600000).toISOString(),published=new Date(now-1800000).toISOString(),observed=new Date(now-7200000).toISOString();
 assert.equal(notify.betaFresh(published,observed,baseline,baseline,72),false);
});

test('migration 0013 upgrades 0012 data without loss and remains idempotent',async()=>{
 const sqlite=new DatabaseSync(':memory:');try{for(let i=1;i<=12;i++){const files=(await import('node:fs')).readdirSync('migrations').filter(n=>n.startsWith(String(i).padStart(4,'0')+'_'));sqlite.exec(await readFile('migrations/'+files[0],'utf8'));}
  sqlite.prepare('INSERT INTO direct_sources(id,url,kind,name,discovered_at) VALUES(?,?,?,?,?)').run('kept','https://example.test','website','source',date);
  const migration=await readFile('migrations/0013_direct_monitor_progress.sql','utf8');sqlite.exec(migration);sqlite.exec(migration);
  assert.equal(sqlite.prepare('SELECT COUNT(*) n FROM direct_sources').get().n,1);
  assert.throws(()=>sqlite.prepare("INSERT INTO direct_monitor_candidates(interest_key,source_id,url,title,content,first_seen,score,status,updated_at) VALUES('a','kept','u','t','c',?,0,'untrusted',?)").run(date,date));
 }finally{sqlite.close();}
});
