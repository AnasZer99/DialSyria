import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {createHmac} from 'node:crypto';
import {validateStagingConfig} from '../scripts/staging-preflight.mjs';
import {loadBeta,loadEngine,loadInterests,loadNotifyRoute,loadStagingMiddleware,loadTelegram,openDatabase} from '../scripts/discovery-runtime.mjs';
const beta=await loadBeta(),telegram=await loadTelegram(),middleware=await loadStagingMiddleware(),engine=await loadEngine(),interests=await loadInterests(),route=await loadNotifyRoute();
const stageId='11111111-2222-4333-8444-555555555555',origin='https://dialsyria-staging.pages.dev';
const context=(request,env)=>({request,env,params:{},waitUntil(){}});
const ago=n=>new Date(Date.now()-n*60000).toISOString();
async function setup(){const {db,sqlite}=await openDatabase(':memory:');sqlite.exec(await readFile('schema.sql','utf8'));return {db,sqlite,env:{DB:db,STAGING_PILOT_MODE:'1',STAGING_D1_ID:stageId,SITE_URL:origin,ALLOW_MOCK_DISCOVERY:'0',TELEGRAM_DELIVERY_ENABLED:'0',TELEGRAM_BOT:'DedicatedStageBot',TELEGRAM_BOT_TOKEN:'123456:'+('a'.repeat(35)),TELEGRAM_WEBHOOK_SECRET:'webhook-secret-'.repeat(3),ADMIN_PASSWORD:'local-test-password-not-real',BETA_ALLOWED_TELEGRAM_IDS:'101,202',TELEGRAM_TEST_CHAT_IDS:'101,202',BETA_DURATION_DAYS:'14'}};}
const post=(url,body,cookie)=>new Request(origin+url,{method:'POST',headers:{origin,'content-type':'application/json',...(cookie?{cookie}:{})},body:JSON.stringify(body)});
const getCookie=(res,name)=>res.headers.getSetCookie().find(x=>x.startsWith(name+'='))?.split(';')[0];

test('offline configuration rejects production D1, bot reuse, placeholders and unsafe overrides',async()=>{
 const production=await readFile('wrangler.toml','utf8');const template=JSON.parse(await readFile('wrangler.staging.example.json','utf8'));
 assert.ok(validateStagingConfig(template,production).length>0);
 const config=structuredClone(template);config.d1_databases[0].database_id=stageId;config.vars.STAGING_D1_ID=stageId;config.vars.TELEGRAM_BOT='DedicatedStageBot';
 assert.deepEqual(validateStagingConfig(config,production),[]);
 const prodId=production.match(/^\s*database_id\s*=\s*"([^"]+)"/m)[1];
 const bad=structuredClone(config);bad.d1_databases[0].database_id=prodId;bad.vars.STAGING_D1_ID=prodId;assert.ok(validateStagingConfig(bad,production).some(x=>x.includes('matches production')));
 for(const mutate of [c=>c.vars.TELEGRAM_BOT='DialSyriaBot',c=>c.vars.TELEGRAM_DELIVERY_ENABLED='1',c=>c.vars.ALLOW_MOCK_DISCOVERY='1',c=>c.d1_databases.push({...c.d1_databases[0]}),c=>c.env={production:{}}]){const item=structuredClone(config);mutate(item);assert.ok(validateStagingConfig(item,production).length>0);}
});

test('staging middleware fails closed for missing marker, production ID and token URLs',async()=>{
 const {db,sqlite,env}=await setup();try{
  const call=(e,path='/beta')=>middleware.onRequest({request:new Request(origin+path),env:e,next:async()=>new Response('ok')});
  assert.equal((await call(env)).status,503);
  sqlite.prepare('INSERT INTO rate_limits(key,window,count) VALUES(?,?,1)').run('staging-db:'+stageId,'staging-only');
  assert.equal((await call(env)).status,200);assert.equal((await call(env,'/manage?token=redacted')).status,403);assert.equal((await call(env,'/api/login')).status,403);
  assert.equal((await call({...env,STAGING_PILOT_MODE:'0'})).status,503);assert.equal((await call({...env,ALLOW_MOCK_DISCOVERY:'1'})).status,503);
  assert.equal((await call({...env,TELEGRAM_BOT_TOKEN:''})).status,503);assert.equal((await call({...env,BETA_ALLOWED_TELEGRAM_IDS:'101,202,303'})).status,503);
  const production=await readFile('wrangler.toml','utf8');const prodId=production.match(/^\s*database_id\s*=\s*"([^"]+)"/m)[1];
  sqlite.prepare('INSERT INTO rate_limits(key,window,count) VALUES(?,?,1)').run('staging-db:'+prodId,'staging-only');
  assert.equal((await call({...env,STAGING_D1_ID:prodId})).status,503);
 }finally{sqlite.close();}
});

test('two invited users authenticate via private code selection without challenge tokens in URLs',async()=>{
 const {sqlite,env}=await setup(),old=globalThis.fetch,calls=[];
 globalThis.fetch=async(input,init)=>{assert.ok(String(input).startsWith('https://api.telegram.org/'));calls.push(JSON.parse(init.body));return new Response('{"ok":true}');};
 const begin=async text=>{const res=await beta.onRequestPost(context(post('/api/beta',{action:'begin',interests:[text]}),env));assert.equal(res.status,200);const body=await res.json();assert.equal(body.staging,true);assert.equal('token' in body,false);return {...body,browser:getCookie(res,'ds_beta_browser')};};
 const update=async data=>telegram.onRequestPost(context(new Request(origin+'/api/telegram',{method:'POST',headers:{'content-type':'application/json','x-telegram-bot-api-secret-token':env.TELEGRAM_WEBHOOK_SECRET},body:JSON.stringify(data)}),env));
 try{
  const a=await begin('امتحانات جامعة إدلب'),b=await begin('مشاريع الخدمات في إدلب');
  await update({message:{text:'/start',chat:{id:303,type:'private'},from:{id:303}}});assert.equal(calls.length,0);
  await update({message:{text:'/start',chat:{id:101,type:'group'},from:{id:101}}});assert.equal(calls.length,0);
  await update({message:{text:'/start',chat:{id:101,type:'private'},from:{id:101}}});const buttons=calls.at(-1).reply_markup.inline_keyboard.flat();assert.ok(buttons.some(x=>x.text===a.code));assert.ok(buttons.some(x=>x.text===b.code));
  const choose=async(user,code)=>{const data=buttons.find(x=>x.text===code).callback_data;assert.match(data,/^p_[a-f0-9]{32}$/);return update({callback_query:{id:'cb',data,from:{id:user},message:{chat:{id:user,type:'private'}}}});};
  await choose(101,a.code);await choose(202,b.code);
  const complete=async c=>{const res=await beta.onRequestPost(context(post('/api/beta',{action:'poll'},c.browser),env));assert.equal(res.status,200);return getCookie(res,'ds_beta_session');};
  const ca=await complete(a),cb=await complete(b);assert.ok(ca && cb && ca!==cb);
  const profile=async cookie=>{const res=await beta.onRequestGet(context(new Request(origin+'/api/beta',{headers:{cookie}}),env));return res.json();};
  assert.match((await profile(ca)).interests[0].text,/جامعة/);assert.match((await profile(cb)).interests[0].text,/الخدمات/);
  assert.equal(sqlite.prepare('SELECT count(*) n FROM subscribers').get().n,2);
  await choose(202,a.code);const replay=await beta.onRequestPost(context(post('/api/beta',{action:'poll'},a.browser),env));assert.equal(replay.status,410);
  const invalid=await beta.onRequestPost(context(post('/api/beta',{action:'begin',interests:['اختبار جديد']}),{...env,BETA_ALLOWED_TELEGRAM_IDS:'101,202,303'}));assert.equal(invalid.status,503);
 }finally{globalThis.fetch=old;sqlite.close();}
});

test('staging manual pilot allows one single-item attempt per user and blocks scheduled delivery',async()=>{
 const {db,sqlite,env}=await setup(),old=globalThis.fetch,calls=[];
 globalThis.fetch=async(_input,init)=>{calls.push(JSON.parse(init.body));return new Response('{"ok":true}');};
 try{
  const text='قرارات جامعة إدلب المتعلقة بالامتحانات والتسجيل';
  sqlite.prepare('INSERT INTO subscribers(id,email,telegram_chat_id,status,created_at) VALUES(?,?,?,?,?)').run('a','a@example.invalid','101','active',ago(30));
  sqlite.prepare('INSERT INTO beta_identities(chat_id,subscriber_id,created_at,created_beta,notifications_enabled_at) VALUES(?,?,?,?,?)').run('101','a',ago(20),1,ago(10));
  sqlite.prepare('INSERT INTO subscriber_interests(id,subscriber_id,text,normalized_text,created_at,updated_at) VALUES(?,?,?,?,?,?)').run('i','a',text,interests.normalizeInterest(text),ago(20),ago(10));
  sqlite.prepare('INSERT INTO direct_sources(id,url,kind,name,discovered_at) VALUES(?,?,?,?,?)').run('src','https://t.me/s/IdlebUniversity','telegram','جامعة إدلب',ago(20));
  sqlite.prepare('INSERT INTO direct_source_interests(interest_key,source_id) VALUES(?,?)').run(engine.normalize(text),'src');
  for(const id of ['11','12'])sqlite.prepare('INSERT INTO direct_items(id,source_id,url,title,content,published_at,first_seen,verification_status) VALUES(?,?,?,?,?,?,?,?)').run(id,'src','https://t.me/IdlebUniversity/'+id,'قرار اختبار القيد في جامعة إدلب','قرار جامعة إدلب بشأن اختبار المقدرة اللغوية للقيد في الماجستير',ago(2),ago(1),'telegram_post_verified');
  const password='fake-admin',exp=Date.now()+60000,token=exp+'.'+createHmac('sha256',password).update('admin:'+exp).digest('hex');
  const postNotify=async(body,overrides={})=>{const req=new Request(origin+'/api/notify',{method:'POST',headers:{'content-type':'application/json',authorization:'Bearer '+token},body:JSON.stringify(body)});const r=await route.onRequestPost(context(req,{...env,ADMIN_PASSWORD:password,TELEGRAM_DELIVERY_ENABLED:'1',...overrides}));return {status:r.status,body:await r.json()};};
  assert.equal((await postNotify({mode:'deliver'})).status,403);
  assert.equal((await postNotify({mode:'deliver',simulate:true,beta_manual:true,subscriber_id:'a'})).status,403);
  assert.equal((await postNotify({mode:'deliver',beta_manual:true,subscriber_id:'a'},{TELEGRAM_DELIVERY_ENABLED:'0'})).status,403);
  assert.equal((await postNotify({mode:'deliver',beta_manual:true,subscriber_id:'a'},{TELEGRAM_TEST_CHAT_IDS:'202'})).status,403);
  const attempts=await Promise.all([postNotify({mode:'deliver',beta_manual:true,subscriber_id:'a'}),postNotify({mode:'deliver',beta_manual:true,subscriber_id:'a'})]);
  assert.equal(attempts.reduce((sum,item)=>sum+(item.body.sent || 0),0),1);assert.equal(calls.length,1);assert.equal((calls[0].text.match(/\/more /g) || []).length,1);
  const again=await postNotify({mode:'deliver',beta_manual:true,subscriber_id:'a'});assert.equal(again.body.pilotAttemptUsed,true);assert.equal(calls.length,1);
  assert.equal(sqlite.prepare("SELECT count(*) n FROM notifications WHERE status='sent'").get().n,1);
  sqlite.prepare('INSERT INTO subscribers(id,email,telegram_chat_id,status,created_at) VALUES(?,?,?,?,?)').run('b','b@example.invalid','202','active',ago(30));
  sqlite.prepare('INSERT INTO beta_identities(chat_id,subscriber_id,created_at,created_beta,notifications_enabled_at) VALUES(?,?,?,?,?)').run('202','b',ago(20),1,ago(10));
  sqlite.prepare('INSERT INTO subscriber_interests(id,subscriber_id,text,normalized_text,created_at,updated_at) VALUES(?,?,?,?,?,?)').run('i-b','b',text,interests.normalizeInterest(text),ago(20),ago(10));
  let attemptsB=0;globalThis.fetch=async()=>{attemptsB++;throw Error('simulated timeout');};
  assert.equal((await postNotify({mode:'deliver',beta_manual:true,subscriber_id:'b'})).body.failed,1);
  assert.equal((await postNotify({mode:'deliver',beta_manual:true,subscriber_id:'b'})).body.pilotAttemptUsed,true);assert.equal(attemptsB,1);
 }finally{globalThis.fetch=old;sqlite.close();}
});
