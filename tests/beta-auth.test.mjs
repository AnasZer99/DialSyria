import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {loadBeta,loadTelegram,loadInterests,loadNotify,loadDigest,loadDirectRoute,loadBetaScheduledRoute,openDatabase} from '../scripts/discovery-runtime.mjs';
import stagingCron from '../cron-worker/staging.js';
const beta=await loadBeta(),telegram=await loadTelegram(),interests=await loadInterests(),notify=await loadNotify(),digest=await loadDigest();
const origin='https://beta.example';
async function setup(){const {db,sqlite}=await openDatabase(':memory:');sqlite.exec(await readFile('schema.sql','utf8'));return {db,sqlite,env:{DB:db,TELEGRAM_BOT:'TestBetaBot',TELEGRAM_BOT_TOKEN:'mock',TELEGRAM_WEBHOOK_SECRET:'mock-secret',BETA_ALLOWED_TELEGRAM_IDS:'101,202',BETA_DURATION_DAYS:'45'}};}
const ctx=(request,env)=>({request,env,params:{},waitUntil(){}});
const cookie=(res,name)=>{const value=res.headers.getSetCookie().find(x=>x.startsWith(name+'='));return value?.split(';')[0] || '';};
async function action(env,body,jar='',options={}){return beta.onRequestPost(ctx(new Request(origin+'/api/beta',{method:'POST',headers:{origin:options.origin??origin,'content-type':'application/json',...(jar?{cookie:jar}:{})},body:JSON.stringify(body)}),env));}
async function begin(env,items=['امتحانات جامعة إدلب']){const r=await action(env,{action:'begin',interests:items});assert.equal(r.status,200);return {...await r.json(),browser:cookie(r,'ds_beta_browser')};}
async function webhook(env,message){return telegram.onRequestPost(ctx(new Request(origin+'/api/telegram',{method:'POST',headers:{'x-telegram-bot-api-secret-token':'mock-secret','content-type':'application/json'},body:JSON.stringify(message)}),env));}
async function start(env,challenge,id=101,type='private',sender=id){return webhook(env,{message:{text:'/start b_'+challenge.token,chat:{id,type},from:{id:sender}}});}
async function approve(env,challenge,id=101,type='private',sender=id){return webhook(env,{callback_query:{id:'callback',data:'b_'+challenge.token,from:{id:sender},message:{chat:{id,type}}}});}
async function complete(env,challenge){const r=await action(env,{action:'poll'},challenge.browser);return {res:r,session:cookie(r,'ds_beta_session')};}
async function register(env,items,id=101){const c=await begin(env,items);await start(env,c,id);await approve(env,c,id);const result=await complete(env,c);assert.equal(result.res.status,200);return {...result,challenge:c};}
function apiRequest(method,path,jar='',body,requestOrigin=origin){return new Request(origin+path,{method,headers:{...(jar?{cookie:jar}:{}),...(method!=='GET'?{origin:requestOrigin,'content-type':'application/json'}:{})},...(body===undefined?{}:{body:JSON.stringify(body)})});}

test('first registration, returning login and sessions do not expose or store raw secrets',async()=>{
 const {env,sqlite}=await setup(),old=globalThis.fetch;let messages=[];globalThis.fetch=async (_url,init)=>{messages.push(JSON.parse(init.body));return new Response('{}',{status:200});};
 try{
  const a=await register(env,['امتحانات جامعة إدلب']);assert.match(a.session,/^ds_beta_session=/);assert.ok(a.res.headers.get('set-cookie').includes('HttpOnly'));assert.ok(a.res.headers.get('set-cookie').includes('Secure'));
  assert.equal(sqlite.prepare('SELECT count(*) n FROM subscribers').get().n,1);assert.equal(sqlite.prepare('SELECT status FROM subscribers').get().status,'paused');
  assert.equal(sqlite.prepare('SELECT count(*) n FROM subscriber_interests').get().n,1);assert.ok(messages[0].text.includes(a.challenge.code));
  assert.notEqual(sqlite.prepare('SELECT session_hash FROM beta_sessions').get().session_hash,a.session.split('=')[1]);
  assert.notEqual(sqlite.prepare('SELECT challenge_hash FROM beta_challenges').get().challenge_hash,a.challenge.token);
  const b=await register(env,[]);assert.equal(sqlite.prepare('SELECT count(*) n FROM subscribers').get().n,1);assert.equal(sqlite.prepare('SELECT count(*) n FROM subscriber_interests').get().n,1);
  assert.notEqual(a.session,b.session);
 }finally{globalThis.fetch=old;sqlite.close();}
});
test('forwarded links require private owner approval and the initiating browser; replay and expiry fail',async()=>{
 const {env,sqlite}=await setup(),old=globalThis.fetch;globalThis.fetch=async()=>new Response('{}');
 try{
  const c=await begin(env);await start(env,c,101,'group');assert.equal(sqlite.prepare('SELECT status FROM beta_challenges').get().status,'pending');
  await start(env,c,101,'private',202);assert.equal(sqlite.prepare('SELECT status FROM beta_challenges').get().status,'pending');
  await start(env,c,101);await approve(env,c,202);assert.equal(sqlite.prepare('SELECT status FROM beta_challenges').get().status,'claimed');
  const pending=await complete(env,c);assert.equal((await pending.res.json()).status,'claimed');
  await approve(env,c,101);assert.equal((await action(env,{action:'poll'},'ds_beta_browser='+('a'.repeat(48)))).status,410);
  assert.equal((await complete(env,c)).res.status,200);assert.equal((await complete(env,c)).res.status,410);
  const expired=await begin(env);sqlite.prepare("UPDATE beta_challenges SET expires_at='2000-01-01T00:00:00.000Z' WHERE status='pending'").run();
  await start(env,expired,101);assert.equal((await complete(env,expired)).res.status,410);
  const unknown=await begin(env);await start(env,unknown,303);assert.equal((await complete(env,unknown)).res.status,200);assert.equal(sqlite.prepare("SELECT status FROM beta_challenges WHERE status='pending' ORDER BY created_at DESC LIMIT 1").get().status,'pending');
 }finally{globalThis.fetch=old;sqlite.close();}
});
test('two users have isolated interests, sessions, CSRF and expiry protection',async()=>{
 const {env,sqlite}=await setup(),old=globalThis.fetch;globalThis.fetch=async()=>new Response('{}');
 try{
  const a=await register(env,['امتحانات جامعة إدلب'],101),b=await register(env,['مشاريع حلب'],202);
  const rows=sqlite.prepare('SELECT id,subscriber_id FROM subscriber_interests').all();const foreign=rows[1].id;
  const denied=await interests.onRequestPatch(ctx(apiRequest('PATCH','/api/interests',a.session,{id:foreign,text:'نص معدّل'}),env));assert.equal(denied.status,404);
  assert.equal((await interests.onRequestGet(ctx(apiRequest('GET','/api/interests',a.session),env))).status,200);
  assert.equal((await interests.onRequestPost(ctx(apiRequest('POST','/api/interests',a.session,{text:'اهتمام آخر'},'https://attacker.example'),env))).status,401);
  assert.equal((await action(env,{action:'pause'},a.session,{origin:'https://attacker.example'})).status,403);
  assert.equal((await action(env,{action:'logout'},a.session)).status,200);assert.equal((await beta.onRequestGet(ctx(apiRequest('GET','/api/beta',a.session),env))).status,401);
  sqlite.prepare("UPDATE beta_sessions SET expires_at='2000-01-01T00:00:00.000Z'").run();assert.equal((await beta.onRequestGet(ctx(apiRequest('GET','/api/beta',b.session),env))).status,401);
 }finally{globalThis.fetch=old;sqlite.close();}
});
test('duplicate linking, pause and cancellation keep notification delivery ineligible',async()=>{
 const {env,sqlite,db}=await setup(),old=globalThis.fetch;globalThis.fetch=async()=>new Response('{}');
 try{
  const a=await register(env,['امتحانات جامعة إدلب']);const id=sqlite.prepare('SELECT id FROM subscribers').get().id;
  assert.equal(await notify.subscriberEligible(db,id),false);
  assert.equal((await action(env,{action:'resume'},a.session)).status,200);assert.equal(await notify.subscriberEligible(db,id),true);
  assert.equal((await action(env,{action:'pause'},a.session)).status,200);assert.equal(await notify.subscriberEligible(db,id),false);
  assert.equal((await action(env,{action:'cancel'},a.session)).status,200);assert.equal(await notify.subscriberEligible(db,id),false);
  assert.equal((await action(env,{action:'resume'},a.session)).status,409);
  const same=await register(env,[]);assert.ok(same.session);assert.equal(sqlite.prepare('SELECT count(*) n FROM beta_identities').get().n,1);
 }finally{globalThis.fetch=old;sqlite.close();}
});

test('legacy duplicate or changed Telegram ownership cannot be used to take over an account',async()=>{
 const {env,sqlite}=await setup(),old=globalThis.fetch;globalThis.fetch=async()=>new Response('{}');
 try{
  const first=await register(env,['امتحانات جامعة إدلب']);
  sqlite.prepare("UPDATE subscribers SET telegram_chat_id='202'").run();
  const c=await begin(env,[]);await start(env,c,101);await approve(env,c,101);
  assert.equal((await complete(env,c)).res.status,409);
  sqlite.prepare('INSERT INTO subscribers(id,email,telegram_chat_id,status,created_at) VALUES(?,?,?,?,?)').run('duplicate','legacy@example.test','202','active',new Date().toISOString());
  const conflict=await begin(env,[]);await start(env,conflict,202);await approve(env,conflict,202);
  assert.equal((await complete(env,conflict)).res.status,409);
  assert.ok(first.session);
 }finally{globalThis.fetch=old;sqlite.close();}
});

test('beta opt in cannot silently enable the legacy scheduled digest',async()=>{
 const {env,sqlite}=await setup(),old=globalThis.fetch;let calls=0;globalThis.fetch=async()=>{calls++;return new Response('{}');};
 try{
  const a=await register(env,['امتحانات جامعة إدلب']);const id=sqlite.prepare('SELECT id FROM subscribers').get().id;
  await action(env,{action:'resume'},a.session);
  sqlite.prepare('INSERT INTO subscriber_topics(subscriber_id,topic) VALUES(?,?)').run(id,'politics');
  calls=0;const result=await digest.runDigest(env,true);
  assert.equal(result.due,0);assert.equal(calls,0);
 }finally{globalThis.fetch=old;sqlite.close();}
});

test('new beta registration reaches one mocked scheduled delivery without duplicates',async()=>{
 const {env,sqlite,db}=await setup(),old=globalThis.fetch,calls=[];
 const direct=await loadDirectRoute(),scheduled=await loadBetaScheduledRoute();
 const cronSecret='local-cron-secret-0123456789-abcdef';
 const fullEnv={...env,CRON_SECRET:cronSecret,TELEGRAM_TEST_CHAT_IDS:'101,202',TELEGRAM_DELIVERY_ENABLED:'1',BETA_SCHEDULED_DELIVERY_ENABLED:'1'};
 const interest='أخبار وإعلانات جامعة إدلب';
 globalThis.fetch=async()=>new Response('{}');
 try{
  const user=await register(env,[interest]);assert.equal((await action(env,{action:'resume'},user.session)).status,200);
  await new Promise(resolve=>setTimeout(resolve,20));const date=new Date().toISOString();
  const html=`<meta property="og:title" content="جامعة إدلب"><div class="tgme_widget_message_wrap"><div data-post="IdlebUniversity/123"><div class="tgme_widget_message_text">تعلن كلية الطب بدء الفصل الدراسي الجديد للطلاب</div><time datetime="${date}"></time></div></div>`;
  globalThis.fetch=async(input,init)=>{const u=String(input);
   if(u==='https://dialsyria-staging.pages.dev/api/direct')return direct.onRequestPost(ctx(new Request(u,init),fullEnv));
   if(u==='https://dialsyria-staging.pages.dev/api/beta-scheduled')return scheduled.onRequestPost(ctx(new Request(u,init),fullEnv));
   if(u==='https://t.me/robots.txt')return new Response('',{status:404});
   if(u==='https://t.me/s/IdlebUniversity'||u==='https://t.me/s/IdlebUniversity/123')return new Response(html);
   if(u.startsWith('https://news.google.com/rss/search'))return new Response('<rss><channel></channel></rss>');
   if(u.startsWith('https://api.telegram.org/')){calls.push(JSON.parse(init.body));return new Response('{"ok":true}');}
   throw Error('unexpected external call');};
  const run=async()=>{const work=[];stagingCron.scheduled({cron:'*/30 * * * *'},{CRON_SECRET:cronSecret,STAGING_SCHEDULER_ENABLED:'1',STAGING_BETA_PREPARATION_ENABLED:'1'},{waitUntil:p=>work.push(p)});await Promise.all(work);};
  await run();await run();assert.equal(calls.length,1);assert.equal(String(calls[0].chat_id),'101');
  assert.equal(sqlite.prepare("SELECT count(*) n FROM notifications WHERE status='sent'").get().n,1);
  assert.equal(sqlite.prepare('SELECT count(*) n FROM interest_monitor_jobs').get().n,1);
 }finally{globalThis.fetch=old;sqlite.close();}
});

test('legacy trial remains a trial when paused and resumed through beta',async()=>{
 const {env,sqlite}=await setup(),old=globalThis.fetch;globalThis.fetch=async()=>new Response('{}');
 try{
  const now=new Date(),end=new Date(now.getTime()+86400000).toISOString();
  sqlite.prepare('INSERT INTO subscribers(id,email,telegram_chat_id,status,trial_ends_at,created_at) VALUES(?,?,?,?,?,?)').run('legacy','legacy@example.test','101','trial',end,now.toISOString());
  const a=await register(env,[]);assert.equal((await action(env,{action:'pause'},a.session)).status,200);assert.equal((await action(env,{action:'resume'},a.session)).status,200);
  assert.equal(sqlite.prepare("SELECT status FROM subscribers WHERE id='legacy'").get().status,'trial');
 }finally{globalThis.fetch=old;sqlite.close();}
});
