import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {createHmac} from 'node:crypto';
import {loadLiveBudget,loadLiveInterest,loadInterests,loadNotifyRoute,openDatabase} from '../scripts/discovery-runtime.mjs';
const {createLiveBudget}=await loadLiveBudget(), live=await loadLiveInterest(), interests=await loadInterests(), route=await loadNotifyRoute();
const interest='قرارات جامعة إدلب المتعلقة بالامتحانات والتسجيل';
async function setup(){
 const {db,sqlite}=await openDatabase(':memory:');sqlite.exec(await readFile('schema.sql','utf8'));
 const now=new Date().toISOString();
 sqlite.prepare('INSERT INTO subscribers(id,email,telegram_chat_id,status,created_at) VALUES(?,?,?,?,?)').run('a','beta@example.invalid','101','active',now);
 sqlite.prepare('INSERT INTO beta_identities(chat_id,subscriber_id,created_at,created_beta,notifications_enabled_at) VALUES(?,?,?,?,?)').run('101','a',now,1,new Date(Date.now()-60000).toISOString());
 sqlite.prepare('INSERT INTO subscriber_interests(id,subscriber_id,text,normalized_text,created_at,updated_at) VALUES(?,?,?,?,?,?)').run('i','a',interest,interests.normalizeInterest(interest),now,now);
 return {db,sqlite};
}
const html='<meta property="og:title" content="جامعة إدلب"><div class="tgme_widget_message_wrap"><div data-post="IdlebUniversity/12"><div class="tgme_widget_message_text">بطولة رياضية وتكريم الفريق في جامعة إدلب</div><time datetime="2026-11-24T11:00:00Z"></time></div></div>';
function provider({throttle=false}={}){let searches=0,telegramCalls=0;return {get searches(){return searches;},get telegramCalls(){return telegramCalls;},fetch:async input=>{const u=String(input);if(u.includes('api.telegram.org')){telegramCalls++;throw Error('real Telegram must never be contacted');}if(u==='https://t.me/robots.txt')return new Response('',{status:404});if(u==='https://t.me/s/IdlebUniversity')return new Response(html);if(u.startsWith('https://news.google.com/rss/search')){searches++;return throttle?new Response('',{status:429,headers:{'Retry-After':'600'}}):new Response('<rss><channel></channel></rss>');}throw Error('unexpected network request');}};}
async function manual(db){const password='only-mock-password',expires=Date.now()+60000,token=expires+'.'+createHmac('sha256',password).update('admin:'+expires).digest('hex');const request=new Request('https://example.org/api/notify',{method:'POST',headers:{authorization:'Bearer '+token,'content-type':'application/json'},body:JSON.stringify({mode:'prepare',beta_manual:true,subscriber_id:'a',refresh_sources:true})});const res=await route.onRequestPost({request,env:{DB:db,ADMIN_PASSWORD:password,BETA_ALLOWED_TELEGRAM_IDS:'101',TELEGRAM_TEST_CHAT_IDS:'101',TELEGRAM_DELIVERY_ENABLED:'0'},params:{},waitUntil(){}});return {status:res.status,body:await res.json()};}

test('budget terminates a fetch that ignores abort and a stalled response body',async()=>{
 let signal;const never=createLiveBudget(async(_u,init)=>{signal=init.signal;return new Promise(()=>{});},100,5,25);
 const start=Date.now();await assert.rejects(never.fetcher('https://mock.invalid'),/timed out|budget exhausted/);assert.ok(Date.now()-start<500);assert.equal(signal.aborted,true);
 const slow=createLiveBudget(async()=>{const response=new Response('x');response.text=()=>new Promise(()=>{});return response;},100,5,25);
 const res=await slow.fetcher('https://mock.invalid');await assert.rejects(res.text(),/timed out|budget exhausted/);
});

test('known sources are checked first, empty search is successful, and Beta never sends in prepare mode',async()=>{
 const {db,sqlite}=await setup(),fake=provider(),old=globalThis.fetch;globalThis.fetch=fake.fetch;
 try{const result=await manual(db);assert.equal(result.status,200);assert.equal(result.body.refreshStatus[0].searchStarted,true);assert.equal(result.body.refreshStatus[0].incomplete,false);assert.equal(result.body.refreshStatus[0].verified,0);assert.equal(result.body.sent,0);assert.ok(fake.searches>=1);assert.equal(fake.telegramCalls,0);assert.equal(sqlite.prepare('SELECT count(*) n FROM notifications').get().n,0);}
 finally{globalThis.fetch=old;sqlite.close();}
});

test('429 marks search incomplete, preserves Retry-After and does not retry the provider',async()=>{
 const {db,sqlite}=await setup(),fake=provider({throttle:true}),old=globalThis.fetch;globalThis.fetch=fake.fetch;
 try{const first=await manual(db);assert.equal(first.status,200);assert.equal(first.body.refreshIncomplete,true);assert.equal(fake.searches,1);assert.ok(first.body.refreshErrors.some(x=>x.includes('429')));assert.ok(Date.parse(sqlite.prepare("SELECT until_at FROM direct_provider_backoff WHERE provider='google-news-rss'").get().until_at)-Date.now()>599000);
 const second=await manual(db);assert.equal(second.body.refreshIncomplete,true);assert.equal(fake.searches,1);assert.equal(fake.telegramCalls,0);}
 finally{globalThis.fetch=old;sqlite.close();}
});

test('a short shared budget reports unprocessed sources and skips search without hanging',async()=>{
 const {db,sqlite}=await setup();let requests=0;
 const fetcher=async()=>{requests++;return new Promise(()=>{});};const budget=createLiveBudget(fetcher,35,24,100);
 try{const before=Date.now();const result=await live.runLiveInterest(db,interest,fetcher,false,budget,1);assert.ok(Date.now()-before<600);assert.equal(result.diagnostics.incomplete,true);assert.equal(result.diagnostics.stages.searchStarted,false);assert.ok(result.diagnostics.errors.length || result.diagnostics.warnings.length);assert.equal(requests,1);}
 finally{sqlite.close();}
});

test('forked interest budgets share deadline and request ceiling',async()=>{
 const parent=createLiveBudget(async()=>new Response('ok'),500,2,200),a=parent.fork(400),b=parent.fork(400);
 await a.fetcher('https://mock.invalid/1');await b.fetcher('https://mock.invalid/2');assert.equal(parent.requests(),2);assert.equal(parent.exhausted(),true);await assert.rejects(b.fetcher('https://mock.invalid/3'),/request budget exhausted/);
});

test('publisher 429 during search is reported and pauses repeated search',async()=>{
 const {db,sqlite}=await setup(),base=provider(),old=globalThis.fetch;let searches=0;
 globalThis.fetch=async input=>{const u=String(input);if(u.startsWith('https://news.google.com/rss/search')){searches++;return new Response(`<rss><channel><item><title>قرار جامعة إدلب حول الامتحانات والتسجيل</title><link>https://local-news.invalid/article/12</link><pubDate>${new Date().toUTCString()}</pubDate></item></channel></rss>`);}if(u==='https://local-news.invalid/robots.txt')return new Response('',{status:429,headers:{'Retry-After':'600'}});return base.fetch(input);};
 try{const first=await manual(db);assert.equal(first.body.refreshIncomplete,true);assert.ok(first.body.refreshErrors.some(x=>x.includes('publisher HTTP 429')));assert.equal(searches,1);assert.equal(sqlite.prepare('SELECT count(*) n FROM notifications').get().n,0);await manual(db);assert.equal(searches,1);assert.equal(base.telegramCalls,0);}
 finally{globalThis.fetch=old;sqlite.close();}
});

test('multiple beta interests share the same elapsed-time ceiling',async()=>{
 const {db,sqlite}=await setup();const now=new Date().toISOString();
 for(const [id,text] of [['j','تحديثات المياه والكهرباء في حلب'],['k','قرارات القبول في التعليم العالي في سوريا']])sqlite.prepare('INSERT INTO subscriber_interests(id,subscriber_id,text,normalized_text,created_at,updated_at) VALUES(?,?,?,?,?,?)').run(id,'a',text,interests.normalizeInterest(text),now,now);
 const oldFetch=globalThis.fetch,oldNow=Date.now;let clock=oldNow(),calls=0;Date.now=()=>clock;
 globalThis.fetch=async input=>{assert.ok(!String(input).includes('api.telegram.org'));calls++;clock+=7000;return new Response('<rss><channel></channel></rss>',{status:200});};
 try{const result=await manual(db);assert.equal(result.status,200);assert.equal(result.body.refreshStatus.length,3);assert.equal(result.body.refreshIncomplete,true);assert.ok(calls<=3);assert.equal(sqlite.prepare('SELECT count(*) n FROM notifications').get().n,0);}
 finally{globalThis.fetch=oldFetch;Date.now=oldNow;sqlite.close();}
});

test('Google timeout falls back to one older Telegram page with verification, freshness and deduplication',async()=>{
 const {db,sqlite}=await setup(),now=new Date().toISOString(),stale=new Date(Date.now()-40*86400000).toISOString();let searches=0,pages=0,postChecks=0;const seen=[];
 const wrap=(id,text,date=now)=>`<div class="tgme_widget_message_wrap"><div data-post="IdlebUniversity/${id}"><div class="tgme_widget_message_text">${text}</div><time datetime="${date}"></time></div></div>`;
 const head='<meta property="og:title" content="جامعة إدلب">';const relevant=wrap(11,'قرار جامعة إدلب بشأن الامتحانات والتسجيل');
 const fake=async input=>{const u=String(input);seen.push(u);if(u.includes('api.telegram.org'))throw Error('Telegram delivery forbidden');if(u==='https://t.me/robots.txt')return new Response('',{status:404});if(u==='https://t.me/s/IdlebUniversity')return new Response(head+wrap(12,'أجرت جامعة إدلب اختباراً جامعياً'));if(u==='https://t.me/s/IdlebUniversity?before=12'){pages++;return new Response(head+wrap(12,'قرار جامعة إدلب بشأن الامتحانات والتسجيل')+relevant+wrap(10,'أجرت جامعة إدلب اختباراً جامعياً')+wrap(8,'قرار جامعة إدلب بشأن الامتحانات',stale));}if(u==='https://t.me/s/IdlebUniversity/11'){postChecks++;return new Response(head+relevant);}if(u.startsWith('https://news.google.com/rss/search')){searches++;return new Promise(()=>{});}throw Error('unexpected network: '+u);};
 try{for(let i=0;i<2;i++){const budget=createLiveBudget(fake,1200,24,30);const result=await live.runLiveInterest(db,interest,fake,false,budget,1);assert.equal(result.diagnostics.stages.fallbackStarted,true);assert.equal(result.diagnostics.incomplete,true);assert.equal(result.results.length,1);assert.equal(result.results[0].url,'https://t.me/IdlebUniversity/11');assert.equal(result.results[0].verification,'telegram_post_verified');assert.ok(result.diagnostics.rejected>=3);assert.ok(result.diagnostics.requests<=24);if(i)assert.ok(result.diagnostics.duplicates>=1);}
 assert.equal(searches,2);assert.equal(pages,2);assert.equal(postChecks,2);assert.equal(sqlite.prepare('SELECT count(*) n FROM direct_items').get().n,1);assert.equal(sqlite.prepare('SELECT count(*) n FROM notifications').get().n,0);assert.ok(!seen.some(x=>x.includes('idlib.edu.sy')));
 }finally{sqlite.close();}
});

test('fallback does not paginate beyond the freshness window',async()=>{
 const {db,sqlite}=await setup();let before=0;const oldDate=new Date(Date.now()-31*86400000).toISOString();
 const html=`<meta property="og:title" content="جامعة إدلب"><div class="tgme_widget_message_wrap"><div data-post="IdlebUniversity/12"><div class="tgme_widget_message_text">رياضة جامعة إدلب</div><time datetime="${oldDate}"></time></div></div>`;
 const fake=async input=>{const u=String(input);if(u.includes('before='))before++;if(u==='https://t.me/robots.txt')return new Response('',{status:404});if(u==='https://t.me/s/IdlebUniversity')return new Response(html);if(u.startsWith('https://news.google.com/rss/search'))return new Response('',{status:429});throw Error('unexpected network');};
 try{const budget=createLiveBudget(fake,1000,24,100);const result=await live.runLiveInterest(db,interest,fake,false,budget,1);assert.equal(result.diagnostics.stages.fallbackStarted,false);assert.equal(before,0);assert.equal(result.diagnostics.incomplete,true);assert.equal(result.results.length,0);}
 finally{sqlite.close();}
});

test('fallback respects robots denial and never requests the restricted channel',async()=>{
 const {db,sqlite}=await setup();const seen=[];
 const fake=async input=>{const u=String(input);seen.push(u);if(u==='https://t.me/robots.txt')return new Response('User-agent: *\nDisallow: /s/');if(u.startsWith('https://news.google.com/rss/search'))return new Response('',{status:429});throw Error('unexpected request to restricted source');};
 try{const result=await live.runLiveInterest(db,interest,fake,false,createLiveBudget(fake,1000,24,100),1);assert.equal(result.diagnostics.stages.fallbackStarted,false);assert.equal(result.diagnostics.incomplete,true);assert.ok(!seen.some(u=>u.startsWith('https://t.me/s/')));assert.equal(result.results.length,0);}
 finally{sqlite.close();}
});

test('older page 429 is recorded and blocks a subsequent source request',async()=>{
 const {db,sqlite}=await setup();const seen=[];const date=new Date().toISOString();
 const page=`<meta property="og:title" content="جامعة إدلب"><div class="tgme_widget_message_wrap"><div data-post="IdlebUniversity/12"><div class="tgme_widget_message_text">خبر رياضي في جامعة إدلب</div><time datetime="${date}"></time></div></div>`;
 const fake=async input=>{const u=String(input);seen.push(u);if(u==='https://t.me/robots.txt')return new Response('',{status:404});if(u==='https://t.me/s/IdlebUniversity')return new Response(page);if(u==='https://t.me/s/IdlebUniversity?before=12')return new Response('',{status:429,headers:{'Retry-After':'600'}});if(u.startsWith('https://news.google.com/rss/search'))return new Response('',{status:429});throw Error('unexpected request');};
 try{const first=await live.runLiveInterest(db,interest,fake,false,createLiveBudget(fake,1000,24,100),1);assert.equal(first.diagnostics.stages.fallbackStarted,true);assert.ok(first.diagnostics.errors.some(x=>x.includes('429')));const count=seen.length;const second=await live.runLiveInterest(db,interest,fake,false,createLiveBudget(fake,1000,24,100),1);assert.equal(second.diagnostics.stages.fallbackStarted,false);assert.equal(seen.length,count);assert.equal(sqlite.prepare('SELECT count(*) n FROM direct_items').get().n,0);}
 finally{sqlite.close();}
});

test('robots rules specific to the before query prevent the older page request',async()=>{
 const {db,sqlite}=await setup(),date=new Date().toISOString();let olderRequests=0;
 const page=`<meta property="og:title" content="جامعة إدلب"><div class="tgme_widget_message_wrap"><div data-post="IdlebUniversity/12"><div class="tgme_widget_message_text">أخبار جامعة إدلب</div><time datetime="${date}"></time></div></div>`;
 const fake=async input=>{const u=String(input);if(u==='https://t.me/robots.txt')return new Response('User-agent: *\nDisallow: /s/IdlebUniversity?before=');if(u==='https://t.me/s/IdlebUniversity')return new Response(page);if(u.includes('?before=')){olderRequests++;throw Error('robots denial was bypassed');}if(u.startsWith('https://news.google.com/rss/search'))return new Response('',{status:429});throw Error('unexpected request');};
 try{const result=await live.runLiveInterest(db,interest,fake,false,createLiveBudget(fake,1000,24,100),1);assert.equal(result.diagnostics.stages.fallbackStarted,true);assert.ok(result.diagnostics.errors.some(x=>x.includes('robots denied')));assert.equal(olderRequests,0);assert.equal(result.results.length,0);}
 finally{sqlite.close();}
});
