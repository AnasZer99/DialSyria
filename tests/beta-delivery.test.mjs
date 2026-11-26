import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {createHmac} from 'node:crypto';
import {DatabaseSync} from 'node:sqlite';
import {loadEngine,loadInterests,loadNotify,loadNotifyRoute,loadBetaScheduledRoute,loadTelegram,openDatabase} from '../scripts/discovery-runtime.mjs';
const engine=await loadEngine(),api=await loadInterests(),notify=await loadNotify(),route=await loadNotifyRoute(),telegram=await loadTelegram();
const one='قرارات جامعة إدلب المتعلقة بالامتحانات والتسجيل',two='مشاريع الخدمات والبنية التحتية في إدلب';
const minute=60000,ago=n=>new Date(Date.now()-n*minute).toISOString();
const policy={invited:'101,202',recipients:'101,202',freshnessHours:72};
const scheduledRoute=await loadBetaScheduledRoute();
async function setup(){
 const {db,sqlite}=await openDatabase(':memory:');sqlite.exec(await readFile('schema.sql','utf8'));
 for(const [id,chat,text] of [['a','101',one],['b','202',two]]){
  sqlite.prepare('INSERT INTO subscribers(id,email,telegram_chat_id,status,created_at,expires_at) VALUES(?,?,?,?,?,?)').run(id,id+'@example.invalid',chat,'active',ago(30),new Date(Date.now()+86400000).toISOString());
  sqlite.prepare('INSERT INTO beta_identities(chat_id,subscriber_id,created_at,created_beta,notifications_enabled_at) VALUES(?,?,?,?,?)').run(chat,id,ago(20),1,ago(10));
  sqlite.prepare('INSERT INTO subscriber_interests(id,subscriber_id,text,normalized_text,created_at,updated_at) VALUES(?,?,?,?,?,?)').run('i-'+id,id,text,api.normalizeInterest(text),ago(20),ago(10));
 }
 sqlite.prepare('INSERT INTO direct_sources(id,url,kind,name,discovered_at) VALUES(?,?,?,?,?)').run('src','https://t.me/s/IdlebUniversity','telegram','جامعة إدلب',ago(20));
 sqlite.prepare('INSERT INTO direct_source_interests(interest_key,source_id) VALUES(?,?)').run(engine.normalize(one),'src');
 const add=(id,{title='قرار امتحان القيد في جامعة إدلب',content='قرار جامعة إدلب بشأن اختبار المقدرة اللغوية للقيد في الماجستير',date=ago(2),seen=ago(1),verification='telegram_post_verified',url='https://t.me/IdlebUniversity/'+id}={})=>sqlite.prepare('INSERT INTO direct_items(id,source_id,url,title,content,published_at,first_seen,verification_status) VALUES(?,?,?,?,?,?,?,?)').run(id,'src',url,title,content,date,seen,verification);
 return {db,sqlite,add};
}
const context=(request,env)=>({request,env,params:{},waitUntil(){}});
function adminToken(password){const exp=Date.now()+3600000;return `${exp}.${createHmac('sha256',password).update('admin:'+exp).digest('hex')}`;}
async function manual(db,body,extra={}){
 const password='local-admin-only',token=adminToken(password);
 const request=new Request('https://example.org/api/notify',{method:'POST',headers:{authorization:'Bearer '+token,'content-type':'application/json'},body:JSON.stringify(body)});
 const env={DB:db,ADMIN_PASSWORD:password,TELEGRAM_DELIVERY_ENABLED:'1',TELEGRAM_BOT_TOKEN:'mock-token',BETA_ALLOWED_TELEGRAM_IDS:'101,202',TELEGRAM_TEST_CHAT_IDS:'101,202',...extra};
 const res=await route.onRequestPost(context(request,env));return {status:res.status,body:await res.json()};
}

test('scheduled beta preparation and delivery require both flags and preserve ownership',async()=>{
 const {db,sqlite,add}=await setup(),old=globalThis.fetch,oldLog=console.log,calls=[],logs=[];add('101');
 console.log=(...args)=>logs.push(args.join(' '));
 globalThis.fetch=async (url,init)=>{assert.ok(String(url).startsWith('https://api.telegram.org/'));calls.push(JSON.parse(init.body));return new Response('{"ok":true}');};
 const request=()=>new Request('https://example.org/api/beta-scheduled',{method:'POST',headers:{'x-cron-secret':'local-cron'}});
 const env={DB:db,CRON_SECRET:'local-cron',BETA_ALLOWED_TELEGRAM_IDS:'101,202',TELEGRAM_TEST_CHAT_IDS:'101,202',TELEGRAM_BOT_TOKEN:'mock-token'};
 try{
  const first=await scheduledRoute.onRequestPost(context(request(),env));assert.equal(first.status,200);assert.equal((await first.json()).prepared,1);assert.equal(calls.length,0);
  await scheduledRoute.onRequestPost(context(request(),{...env,TELEGRAM_DELIVERY_ENABLED:'1'}));assert.equal(calls.length,0);
  const enabled={...env,TELEGRAM_DELIVERY_ENABLED:'1',BETA_SCHEDULED_DELIVERY_ENABLED:'1'};
  const both=await Promise.all([scheduledRoute.onRequestPost(context(request(),enabled)),scheduledRoute.onRequestPost(context(request(),enabled))]);
  assert.ok(both.every(r=>r.status===200));assert.equal(calls.length,1);assert.equal(String(calls[0].chat_id),'101');
  await scheduledRoute.onRequestPost(context(request(),enabled));assert.equal(calls.length,1);
  assert.ok(logs.every(x=>!x.includes('local-cron') && !x.includes('101') && !x.includes(one)));
 }finally{globalThis.fetch=old;console.log=oldLog;sqlite.close();}
});

test('scheduled beta does not retry failed or stale ambiguous claims',async()=>{
 const {db,sqlite,add}=await setup();try{add('101');await notify.prepareNotifications(db,'a',{beta:policy});
  const failed=notify.createMockTelegramTransport({failError:'ambiguous timeout'});
  assert.equal((await notify.deliverPending(db,'a',failed,{beta:policy,safeNoRetry:true})).failed,1);
  const mock=notify.createMockTelegramTransport();assert.equal((await notify.deliverPending(db,'a',mock,{beta:policy,safeNoRetry:true})).sent,0);
  sqlite.prepare("UPDATE notifications SET status='sending',claimed_at='2000-01-01T00:00:00.000Z'").run();
  assert.equal((await notify.deliverPending(db,'a',mock,{beta:policy,safeNoRetry:true})).sent,0);assert.equal(mock.messages.length,0);
 }finally{sqlite.close();}
});

test('scheduled beta does not repeat an ambiguous crash after transport acceptance',async()=>{
 const {db,sqlite,add}=await setup();try{add('101');await notify.prepareNotifications(db,'a',{beta:policy});
  let accepted=0;const transport={send:async()=>{accepted++;throw Error('simulated crash after acceptance');}};
  await assert.rejects(notify.deliverPending(db,'a',transport,{beta:policy,safeNoRetry:true}));
  assert.equal(accepted,1);assert.equal(sqlite.prepare('SELECT status FROM notifications').get().status,'sending');
  sqlite.prepare("UPDATE notifications SET claimed_at='2000-01-01T00:00:00.000Z'").run();
  const mock=notify.createMockTelegramTransport();assert.equal((await notify.deliverPending(db,'a',mock,{beta:policy,safeNoRetry:true})).sent,0);assert.equal(mock.messages.length,0);
 }finally{sqlite.close();}
});

test('isolates two beta users and sends only fresh, relevant verified content after consent',async()=>{
 const {db,sqlite,add}=await setup();
 try{
  add('101');add('102',{date:ago(73*60)});add('103',{date:null});add('104',{seen:ago(11)});add('105',{verification:'unverified'});add('106',{title:'اجتماع رياضي',content:'تغطية مباراة لكرة القدم'});
  const a=await notify.prepareNotifications(db,'a',{beta:policy}),b=await notify.prepareNotifications(db,'b',{beta:policy});
  assert.equal(a.items.length,1);assert.equal(b.items.length,0);assert.equal(a.items[0].itemId,'101');
  const stored=sqlite.prepare('SELECT published_at,observed_at,prepared_at FROM notifications').get();assert.ok(stored.published_at && stored.observed_at && stored.prepared_at);assert.notEqual(stored.observed_at,stored.prepared_at);
  const mock=notify.createMockTelegramTransport();assert.equal((await notify.deliverPending(db,'a',mock,{beta:policy})).sent,1);
  assert.match(mock.messages[0],/الاهتمام: قرارات جامعة إدلب/);assert.match(mock.messages[0],/جامعة إدلب/);assert.match(mock.messages[0],/https:\/\/t.me\/IdlebUniversity\/101/);assert.match(mock.messages[0],new RegExp('/more '+a.items[0].id));
  assert.equal((await notify.deliverPending(db,'b',mock,{beta:policy})).sent,0);assert.equal(mock.messages.length,1);
 }finally{sqlite.close();}
});

test('general institutional news preserves source verification, freshness, baseline and duplicate protection',async()=>{
 const {db,sqlite,add}=await setup(),general='أخبار وإعلانات جامعة إدلب';
 try{
  sqlite.prepare('UPDATE subscriber_interests SET text=?, normalized_text=? WHERE id=?').run(general,api.normalizeInterest(general),'i-a');
  sqlite.prepare('INSERT INTO direct_source_interests(interest_key,source_id) VALUES(?,?)').run(engine.normalize(general),'src');
  const valid={title:'تعلن كلية الطب بدء الفصل الدراسي',content:'يبدأ الطلاب دراستهم في كلية الطب'};
  add('201',valid);add('202',{...valid,date:ago(73*60)});add('203',{...valid,date:null});add('204',{...valid,seen:ago(11)});add('205',{...valid,date:ago(11)});add('206',{...valid,verification:'unverified'});add('207',{...valid,url:'https://t.me/OtherUniversity/207'});add('208',{title:'أسعار الخضار',content:'أسعار الخضار في الأسواق'});
  const result=await notify.prepareNotifications(db,'a',{beta:policy});assert.equal(result.items.length,1);assert.equal(result.items[0].itemId,'201');
  const mock=notify.createMockTelegramTransport();assert.equal((await notify.deliverPending(db,'a',mock,{beta:policy})).sent,1);assert.equal(mock.messages.length,1);
  assert.equal((await notify.prepareNotifications(db,'a',{beta:policy})).items.length,0);
 }finally{sqlite.close();}
});

test('freshness rejects missing, ambiguous, stale, future and pre-baseline dates',()=>{
 const baseline=ago(10),interest=ago(10);assert.equal(notify.betaFresh(ago(2),ago(1),baseline,interest,72),true);
 for(const value of [null,'2026-11-24','bad',ago(73*60),new Date(Date.now()+3600000).toISOString()])assert.equal(notify.betaFresh(value,ago(1),baseline,interest,72),false);
 assert.equal(notify.betaFresh(ago(2),ago(11),baseline,interest,72),false);
  assert.equal(notify.betaFresh(ago(11),ago(1),baseline,interest,72),false,'historical publication discovered after consent');
 assert.equal(notify.betaFresh(ago(2),ago(1),baseline,ago(0.5),72),false);
 assert.equal(notify.betaFresh(ago(2*60),ago(1),baseline,interest,1),false);
});

test('additive migration retains historical notification rows and requires new opt-in',async()=>{
 const sqlite=new DatabaseSync(':memory:');try{
  sqlite.exec(await readFile('schema.sql','utf8'));
  for(const name of ['0001_discovery.sql','0002_discovery_provenance.sql','0003_direct_sources.sql','0004_subscriber_interests.sql','0005_discovery_mock_flag.sql','0006_notifications.sql','0007_telegram_link_tokens.sql','0008_notification_delivery_claim.sql','0009_direct_verification.sql','0010_beta_auth.sql'])sqlite.exec(await readFile('migrations/'+name,'utf8'));
  sqlite.prepare('INSERT INTO subscribers(id,email,status,telegram_chat_id,created_at) VALUES(?,?,?,?,?)').run('old','old@example.invalid','active','101',ago(20));
  sqlite.prepare('INSERT INTO beta_identities(chat_id,subscriber_id,created_at,created_beta) VALUES(?,?,?,?)').run('101','old',ago(20),1);
  sqlite.prepare('INSERT INTO notifications(id,subscriber_id,item_kind,item_id,interest_key,title,url,status,prepared_at) VALUES(?,?,?,?,?,?,?,?,?)').run('n','old','direct','item','interest','Old','https://example.org/old','prepared',ago(2));
  sqlite.exec(await readFile('migrations/0011_beta_delivery.sql','utf8'));
  assert.equal(sqlite.prepare("SELECT notifications_enabled_at FROM beta_identities WHERE subscriber_id='old'").get().notifications_enabled_at,null);
  const row=sqlite.prepare("SELECT title,observed_at FROM notifications WHERE id='n'").get();assert.equal(row.title,'Old');assert.equal(row.observed_at,null);
 }finally{sqlite.close();}
});

test('consent, private linkage, invitations and ownership are checked again immediately before send',async()=>{
 for(const change of ['pause','cancel','expire','uninvite','removeInterest','wrongChat','group','unverify','missingDate','changedSource','stale']){
  const {db,sqlite,add}=await setup();try{
   add('101');await notify.prepareNotifications(db,'a',{beta:policy});const mock=notify.createMockTelegramTransport();let current=policy;
   if(change==='pause')sqlite.prepare("UPDATE subscribers SET status='paused' WHERE id='a'").run();
   if(change==='cancel')sqlite.prepare("UPDATE subscribers SET status='cancelled' WHERE id='a'").run();
   if(change==='expire')sqlite.prepare("UPDATE subscribers SET expires_at=? WHERE id='a'").run(ago(1));
   if(change==='uninvite')current={...policy,invited:'202'};
   if(change==='removeInterest')sqlite.prepare("DELETE FROM subscriber_interests WHERE subscriber_id='a'").run();
   if(change==='wrongChat')sqlite.prepare("UPDATE subscribers SET telegram_chat_id='303' WHERE id='a'").run();
   if(change==='group'){sqlite.prepare("UPDATE subscribers SET telegram_chat_id='-100101' WHERE id='a'").run();sqlite.prepare("UPDATE beta_identities SET chat_id='-100101' WHERE subscriber_id='a'").run();}
   if(change==='unverify')sqlite.prepare("UPDATE direct_items SET verification_status='unverified'").run();
   if(change==='missingDate')sqlite.prepare('UPDATE direct_items SET published_at=NULL').run();
   if(change==='changedSource')sqlite.prepare("UPDATE direct_sources SET name='مصدر مختلف'").run();
   if(change==='stale')sqlite.prepare('UPDATE notifications SET published_at=?').run(ago(73*60));
   assert.equal((await notify.deliverPending(db,'a',mock,{beta:current})).sent,0,change);assert.equal(mock.messages.length,0,change);
  }finally{sqlite.close();}
 }
});

test('a beta account whose identity link is missing never falls back to legacy delivery',async()=>{
 const {db,sqlite,add}=await setup();try{
  const id='beta_'+'a'.repeat(64);
  sqlite.prepare('INSERT INTO subscribers(id,email,telegram_chat_id,status,created_at) VALUES(?,?,?,?,?)').run(id,'missing@example.invalid','303','active',ago(30));
  sqlite.prepare('INSERT INTO subscriber_interests(id,subscriber_id,text,normalized_text,created_at,updated_at) VALUES(?,?,?,?,?,?)').run('missing-interest',id,one,api.normalizeInterest(one),ago(20),ago(10));
  add('101');assert.equal((await notify.prepareNotifications(db,id)).items.length,0);
  assert.equal((await notify.prepareNotifications(db,id,{beta:{invited:'303',recipients:'303'}})).items.length,0);
  const transport=notify.createMockTelegramTransport();assert.equal((await notify.deliverPending(db,id,transport)).sent,0);assert.equal(transport.messages.length,0);
 }finally{sqlite.close();}
});

test('failed sends retry once, overlapping claims and cross-store canonical URLs do not duplicate',async()=>{
 const {db,sqlite,add}=await setup();try{
  add('101');const url='https://t.me/IdlebUniversity/101';
  sqlite.prepare('INSERT INTO discovery_items(id,url,title_key,title,description,source,published_at,discovered_at,is_mock,publisher_published_at,original_url,verification_status) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)').run('duplicate','https://news.example.org/a','dup-key','قرار امتحان القيد في جامعة إدلب','قرار جامعة إدلب بشأن اختبار المقدرة اللغوية للقيد في الماجستير','جامعة إدلب',ago(2),ago(1),0,ago(2),url+'?utm_source=x','publisher_metadata; title_match');
  sqlite.prepare('INSERT INTO discovery_item_interests(interest_key,item_id,score) VALUES(?,?,?)').run(engine.normalize(one),'duplicate',1);
  const prepared=await Promise.all([notify.prepareNotifications(db,'a',{beta:policy}),notify.prepareNotifications(db,'a',{beta:policy})]);
  assert.equal(prepared.reduce((n,x)=>n+x.items.length,0),1);
  assert.equal((await notify.deliverPending(db,'a',notify.createMockTelegramTransport({failError:'outage'}),{beta:policy})).failed,1);
  const mock=notify.createMockTelegramTransport();const both=await Promise.all([notify.deliverPending(db,'a',mock,{beta:policy}),notify.deliverPending(db,'a',mock,{beta:policy})]);
  assert.equal(both.reduce((n,x)=>n+x.sent,0),1);assert.equal(mock.messages.length,1);assert.equal((await notify.deliverPending(db,'a',mock,{beta:policy})).sent,0);
 }finally{sqlite.close();}
});

test('manual admin route excludes cron beta sends and /more is scoped to the requesting chat',async()=>{
 const {db,sqlite,add}=await setup(),old=globalThis.fetch;const messages=[];
 globalThis.fetch=async(input,init)=>{assert.ok(String(input).startsWith('https://api.telegram.org/'));messages.push(JSON.parse(init.body));return new Response('{"ok":true}');};
 try{
  add('101');const env={DB:db,CRON_SECRET:'cron',TELEGRAM_DELIVERY_ENABLED:'1',TELEGRAM_BOT_TOKEN:'mock-token',TELEGRAM_TEST_CHAT_IDS:'101,202',BETA_ALLOWED_TELEGRAM_IDS:'101,202'};
  const cronReq=new Request('https://example.org/api/notify',{method:'POST',headers:{'x-cron-secret':'cron','content-type':'application/json'},body:JSON.stringify({mode:'deliver'})});
  assert.equal((await route.onRequestPost(context(cronReq,env))).status,200);assert.equal(messages.length,0);
  const noAdmin=new Request('https://example.org/api/notify',{method:'POST',headers:{'x-cron-secret':'cron','content-type':'application/json'},body:JSON.stringify({mode:'deliver',beta_manual:true,subscriber_id:'a'})});
  assert.equal((await route.onRequestPost(context(noAdmin,env))).status,403);
  const result=await manual(db,{mode:'deliver',beta_manual:true,subscriber_id:'a'});assert.equal(result.status,200);assert.equal(result.body.sent,1);assert.equal(messages.length,1);assert.equal(String(messages[0].chat_id),'101');
  assert.equal((await manual(db,{mode:'deliver',beta_manual:true,subscriber_id:'a'})).body.sent,0);
  const id=sqlite.prepare("SELECT id FROM notifications WHERE subscriber_id='a' AND status='sent'").get().id;
  const webhook=async chat=>telegram.onRequestPost(context(new Request('https://example.org/api/telegram',{method:'POST',headers:{'content-type':'application/json','x-telegram-bot-api-secret-token':'secret'},body:JSON.stringify({message:{text:'/more '+id,chat:{id:chat,type:'private'},from:{id:chat}}})}),{...env,TELEGRAM_WEBHOOK_SECRET:'secret'}));
  await webhook(202);assert.match(messages.at(-1).text,/لا يوجد/);await webhook(101);assert.match(messages.at(-1).text,/امتحان القيد/);
 }finally{globalThis.fetch=old;sqlite.close();}
});

test('mocked end-to-end: source monitoring, verification, storage and one manual private delivery',async()=>{
 const {db,sqlite}=await setup(),old=globalThis.fetch;const sends=[];
 const date=ago(2),post='<meta property="og:title" content="جامعة إدلب"><div class="tgme_widget_message_wrap"><div data-post="IdlebUniversity/123"><div class="tgme_widget_message_text">قرار جامعة إدلب بشأن اختبار المقدرة اللغوية للقيد في الماجستير</div><time datetime="'+date+'"></time></div></div>';
 globalThis.fetch=async(input,init)=>{
  const url=String(input);
  if(url==='https://t.me/robots.txt')return new Response('',{status:404});
  if(url==='https://t.me/s/IdlebUniversity'||url==='https://t.me/s/IdlebUniversity/123')return new Response(post);
  if(url.startsWith('https://news.google.com/'))return new Response('<rss><channel></channel></rss>');
  if(url.startsWith('https://api.telegram.org/')){sends.push(JSON.parse(init.body));return new Response('{"ok":true}');}
  throw Error('Unexpected network request in mocked test');
 };
 try{
  const result=await manual(db,{mode:'deliver',beta_manual:true,subscriber_id:'a',refresh_sources:true});
  assert.equal(result.status,200);assert.equal(result.body.sent,1);assert.equal(sends.length,1);assert.equal(String(sends[0].chat_id),'101');
  assert.match(sends[0].text,/https:\/\/t.me\/IdlebUniversity\/123/);assert.match(sends[0].text,/\/more [a-f0-9-]+/);
  const item=sqlite.prepare("SELECT verification_status FROM direct_items WHERE url='https://t.me/IdlebUniversity/123'").get();assert.equal(item.verification_status,'telegram_post_verified');
  assert.equal((await manual(db,{mode:'deliver',beta_manual:true,subscriber_id:'a',refresh_sources:true})).body.sent,0);assert.equal(sends.length,1);
 }finally{globalThis.fetch=old;sqlite.close();}
});
