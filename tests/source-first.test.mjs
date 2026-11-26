import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {DatabaseSync} from 'node:sqlite';
import {loadDirect,loadEngine,loadInterestDiscovery,loadNotify,openDatabase} from '../scripts/discovery-runtime.mjs';

const engine=await loadEngine(), route=await loadInterestDiscovery(), notify=await loadNotify();
const direct=await loadDirect();
const uni='قرارات جامعة إدلب المتعلقة بالامتحانات والتسجيل';
const generalUni='أخبار وإعلانات جامعة إدلب';
const ministry='قرارات وزارة التعليم العالي السورية المتعلقة بالقبول الجامعي';
const infra='مشاريع الخدمات والبنية التحتية في إدلب';
const exam='قرار جامعة إدلب بشأن امتحانات التسجيل في المعهد العالي للغات';
const road='الدانا تختصر الطريق إلى أوتوستراد إدلب – حلب بتزفيت المحلّق الجنوبي';
const timestamp=new Date().toISOString();
const candidate=(title,description=title)=>({title,description,url:'https://publisher.example/a',source:'مصدر',publishedAt:timestamp,provider:'direct'});

async function setup(text){
 const {db,sqlite}=await openDatabase(':memory:');sqlite.exec(await readFile('schema.sql','utf8'));
 sqlite.prepare('INSERT INTO subscribers(id,email,status,created_at,magic_token,magic_expires) VALUES(?,?,?,?,?,?)').run('a','a@example.test','active',timestamp,'token-a','2999-01-01');
 sqlite.prepare('INSERT INTO subscriber_interests(id,subscriber_id,text,normalized_text,created_at,updated_at) VALUES(?,?,?,?,?,?)').run('i','a',text,engine.normalize(text),timestamp,timestamp);
 return {db,sqlite};
}
const request=()=>new Request('https://example.test/api/interests/discover',{method:'POST',headers:{authorization:'Bearer token-a','content-type':'application/json'},body:JSON.stringify({id:'i',mode:'live'})});
async function run(db){const res=await route.onRequestPost({request:request(),env:{DB:db},params:{},waitUntil(){}});assert.equal(res.status,200);return res.json();}

test('exam decisions accept Arabic accusative forms without accepting a general test report',()=>{
 assert.equal(engine.evaluateDirect(uni,candidate('أصدرت جامعة إدلب قرارًا بشأن الامتحانات والتسجيل')).accepted,true);
 assert.equal(engine.evaluateDirect(uni,candidate('أصدرت جامعة إدلب تعميمًا بشأن الامتحانات والتسجيل')).accepted,true);
 assert.equal(engine.evaluateDirect(uni,candidate('أجرت جامعة إدلب اختبارًا جامعيًا')).accepted,false);
});

test('general university interests require a matching verified institution and academic content',()=>{
 const context={institution:'idlib_university'}, news=candidate('تعلن كلية الطب بدء الفصل الدراسي للطلاب');
 assert.equal(engine.evaluate(generalUni,candidate('جامعة إدلب تعلن بدء الفصل الدراسي')).accepted,true);
 assert.equal(engine.evaluateDirect('أخبار الجامعة وإعلاناتها في إدلب',news,Date.now(),context).accepted,true);
 assert.equal(engine.evaluateDirect(generalUni,news).accepted,false);
 assert.equal(engine.evaluateDirect(generalUni,news,Date.now(),context).accepted,true);
 assert.equal(engine.evaluateDirect(generalUni,candidate('أسعار الخضار في السوق'),Date.now(),context).accepted,false);
 assert.equal(engine.evaluateDirect(generalUni,candidate('طلاب جامعة حلب يبدأون الفصل الدراسي'),Date.now(),context).accepted,false);
 assert.equal(engine.evaluateDirect(uni,news,Date.now(),context).accepted,false);
 assert.equal(engine.evaluateDirect(generalUni,{...news,publishedAt:new Date(Date.now()-31*86400000).toISOString()},Date.now(),context).accepted,false);
 const ministryGeneral='أخبار وإعلانات وزارة التعليم العالي',ministryContext={institution:'higher_education_ministry'};
 assert.equal(engine.evaluateDirect(ministryGeneral,news).accepted,false);
 assert.equal(engine.evaluateDirect(ministryGeneral,news,Date.now(),ministryContext).accepted,true);
 assert.equal(engine.evaluateDirect('آخر أخبار وإعلانات وزارة التعليم العالي',news,Date.now(),ministryContext).accepted,true);
 assert.equal(engine.evaluateDirect('آخر أخبار وإعلانات وزارة التعليم العالي',news).accepted,false);
 assert.equal(engine.evaluateDirect(ministryGeneral,news,Date.now(),context).accepted,false);
 assert.equal(engine.evaluateDirect(ministry,news,Date.now(),ministryContext).accepted,false);
});

test('busy source advances past verified posts without bypassing permalink verification',async()=>{
 const {db,sqlite}=await setup(generalUni);
 sqlite.prepare('INSERT INTO direct_sources(id,url,kind,name,discovered_at) VALUES(?,?,?,?,?)').run('source','https://t.me/s/IdlebUniversity','telegram','جامعة إدلب',timestamp);
 sqlite.prepare('INSERT INTO direct_source_interests(interest_key,source_id) VALUES(?,?)').run(engine.normalize(generalUni),'source');
 const post=id=>`<div class="tgme_widget_message_wrap"><div data-post="IdlebUniversity/${id}"><div class="tgme_widget_message_text">تعلن كلية الطب بدء الفصل الدراسي للطلاب ${id}</div><time datetime="${timestamp}"></time></div></div>`;
 const head='<meta property="og:title" content="جامعة إدلب">', ids=[1,2,3,4,5,6],verified=[];
 const fetcher=async input=>{const u=String(input);if(u==='https://t.me/robots.txt')return new Response('',{status:404});if(u==='https://t.me/s/IdlebUniversity')return new Response(head+ids.map(post).join(''));const id=Number(u.split('/').pop());if(ids.includes(id)){verified.push(id);return new Response(head+post(id));}throw Error('unexpected network');};
 try{const first=await direct.monitorDirectSources(db,generalUni,{fetcher});assert.equal(first.items.length,4);assert.equal(first.incomplete,true);
  const second=await direct.monitorDirectSources(db,generalUni,{fetcher});assert.equal(sqlite.prepare('SELECT count(*) n FROM direct_items').get().n,6);assert.equal(second.incomplete,false);assert.equal(second.observations[0].unprocessed,0);
  assert.equal(new Set([...first.items,...second.items].map(x=>x.url)).size,6);assert.equal(verified.length,8);
  assert.ok(second.items.every(item=>item.verification==='telegram_post_verified'));
 }finally{sqlite.close();}
});

test('configured channel general news verifies the exact post, rejects unrelated and unknown sources, and deduplicates',async()=>{
 const {db,sqlite}=await setup(generalUni),old=globalThis.fetch,postText='تعلن كلية الطب بدء الفصل الدراسي الجديد للطلاب';
 sqlite.prepare('INSERT INTO direct_sources(id,url,kind,name,discovered_at) VALUES(?,?,?,?,?)').run('other','https://t.me/s/OtherUniversity','telegram','جامعة إدلب',timestamp);
 sqlite.prepare('INSERT INTO direct_source_interests(interest_key,source_id) VALUES(?,?)').run(engine.normalize(generalUni),'other');
 const post=(channel,id,text)=>`<div class="tgme_widget_message_wrap"><div data-post="${channel}/${id}"><div class="tgme_widget_message_text">${text}</div><time datetime="${timestamp}"></time></div></div>`;
 const head='<meta property="og:title" content="جامعة إدلب">',good=post('IdlebUniversity',12,postText);
 globalThis.fetch=async input=>{const u=String(input);if(u==='https://t.me/robots.txt')return new Response('',{status:404});if(u==='https://t.me/s/IdlebUniversity')return new Response(head+good+post('IdlebUniversity',13,'أسعار الخضار في السوق'));if(u==='https://t.me/s/IdlebUniversity/12')return new Response(head+good);if(u==='https://t.me/s/OtherUniversity')return new Response(head+post('OtherUniversity',12,postText));if(u.startsWith('https://news.google.com/rss/search'))return new Response('<rss></rss>');throw Error('unexpected network');};
 try{const result=await run(db);assert.equal(result.results.length,1);assert.equal(result.results[0].url,'https://t.me/IdlebUniversity/12');assert.equal(result.results[0].verification,'telegram_post_verified');assert.ok(result.diagnostics.rejected>=2);assert.equal((await notify.prepareNotifications(db,'a')).items.length,1);assert.equal((await notify.prepareNotifications(db,'a')).items.length,0);const again=await run(db);assert.ok(again.diagnostics.duplicates>=1);assert.equal(sqlite.prepare('SELECT count(*) n FROM direct_items').get().n,1);}
 finally{globalThis.fetch=old;sqlite.close();}
});

test('general ministry interest accepts only its configured channel and verified post',async()=>{
 const {db,sqlite}=await setup('أخبار وإعلانات وزارة التعليم العالي'),old=globalThis.fetch;
 const page=`<meta property="og:title" content="وزارة التعليم العالي والبحث العلمي السورية"><div class="tgme_widget_message_wrap"><div data-post="SyMOHEASR/55"><div class="tgme_widget_message_text">تعلن كلية الطب بدء الفصل الدراسي للطلاب</div><time datetime="${timestamp}"></time></div></div>`;
 globalThis.fetch=async input=>{const u=String(input);if(u==='https://t.me/robots.txt')return new Response('',{status:404});if(u==='https://t.me/s/SyMOHEASR'||u==='https://t.me/s/SyMOHEASR/55')return new Response(page);if(u.startsWith('https://news.google.com/rss/search'))return new Response('<rss></rss>');throw Error('unexpected network');};
 try{const result=await run(db);assert.equal(result.results.length,1);assert.equal(result.results[0].url,'https://t.me/SyMOHEASR/55');assert.equal(result.results[0].verification,'telegram_post_verified');assert.equal((await notify.prepareNotifications(db,'a')).items.length,1);}
 finally{globalThis.fetch=old;sqlite.close();}
});

test('Arabic relevance accepts explicit exam decisions and road reports while rejecting unrelated news',()=>{
 assert.equal(engine.evaluateDirect(uni,candidate(exam)).accepted,true);
 assert.equal(engine.evaluateDirect(uni,candidate('أجرى المعهد العالي للغات في جامعة إدلب اختبار المقدرة اللغوية')).accepted,false);
 assert.equal(engine.evaluateDirect(uni,candidate('استقرار عملية اختبار القيد في جامعة إدلب')).accepted,false);
 assert.equal(engine.evaluateDirect(infra,candidate(road,'انطلقت أعمال تزفيت الطريق في مدينة الدانا بريف إدلب')).accepted,true);
 assert.equal(engine.evaluateDirect(infra,candidate('إعادة تأهيل مشفى معرة النعمان الوطني')).accepted,true);
 assert.equal(engine.evaluateDirect(infra,candidate('وضع حجر الأساس لمشفى سنجار بريف إدلب')).accepted,true);
 assert.equal(engine.evaluateDirect(infra,candidate('إصابة رجل نُقل إلى مشفى في إدلب')).accepted,false);
 assert.equal(engine.evaluateDirect(ministry,candidate('بحث التعاون الأكاديمي مع الدنمارك','وزارة التعليم العالي والبحث العلمي')).accepted,false);
 assert.equal(engine.evaluateDirect(ministry,candidate('موعد الامتحان الطبي للتقدم لمفاضلة الدراسات العليا','وزارة التعليم العالي والبحث العلمي')).accepted,false);
 assert.equal(engine.evaluateDirect(ministry,candidate('أرقام من مفاضلة القبول الجامعي للعام الدراسي')).accepted,true);
 assert.equal(engine.evaluateDirect(infra,candidate('حادث سير على طريق إدلب','وقوع إصابات قرب طريق إدلب')).accepted,false);
});

test('source-first monitors a configured university channel, verifies the exact post and deduplicates',async()=>{
 const {db,sqlite}=await setup(uni); const old=globalThis.fetch;
 const page=`<meta property="og:title" content="جامعة إدلب"><div class="tgme_widget_message_wrap"><div data-post="IdlebUniversity/12"><div class="tgme_widget_message_text">${exam}</div><time datetime="${timestamp}"></time></div></div>`;
 let seen=[];
 globalThis.fetch=async input=>{const u=String(input);seen.push(u);if(u==='https://t.me/robots.txt')return new Response('',{status:404});if(u==='https://t.me/s/IdlebUniversity'||u==='https://t.me/s/IdlebUniversity/12')return new Response(page);if(u.startsWith('https://news.google.com/rss/search'))return new Response('<rss></rss>');throw Error('unexpected network');};
 try{
  const first=await run(db);assert.equal(first.results.length,1);assert.equal(first.results[0].url,'https://t.me/IdlebUniversity/12');
  assert.equal(first.results[0].verification,'telegram_post_verified');assert.equal(first.results[0].sourceRole,'institutional_self_declared');
  assert.ok(first.diagnostics.disabledSources.some(s=>s.source==='https://idlib.university/'));
  assert.ok(seen.indexOf('https://t.me/s/IdlebUniversity')<seen.findIndex(u=>u.includes('news.google.com')));
  assert.equal((await notify.prepareNotifications(db,'a')).items.length,1);
  const again=await run(db);assert.equal(again.results.length,1);assert.ok(again.diagnostics.duplicates>=1);
  assert.equal(sqlite.prepare('SELECT count(*) n FROM direct_items').get().n,1);
 }finally{globalThis.fetch=old;sqlite.close();}
});

test('mismatched Telegram permalink never creates a deliverable item',async()=>{
 const {db,sqlite}=await setup(uni);const old=globalThis.fetch;
 const post=(id)=>`<meta property="og:title" content="جامعة إدلب"><div class="tgme_widget_message_wrap"><div data-post="IdlebUniversity/${id}"><div class="tgme_widget_message_text">${exam}</div><time datetime="${timestamp}"></time></div></div>`;
 globalThis.fetch=async input=>{const u=String(input);if(u==='https://t.me/robots.txt')return new Response('',{status:404});if(u==='https://t.me/s/IdlebUniversity')return new Response(post('12'));if(u==='https://t.me/s/IdlebUniversity/12')return new Response(post('99'));if(u.startsWith('https://news.google.com/rss/search'))return new Response('<rss></rss>');throw Error('unexpected network');};
 try{const result=await run(db);assert.deepEqual(result.results,[]);assert.equal(result.diagnostics.sources[0].reasons['post permalink verification mismatch'],1);assert.equal((await notify.prepareNotifications(db,'a')).items.length,0);}
 finally{globalThis.fetch=old;sqlite.close();}
});

test('configured channel identity mismatch is rejected before reading posts',async()=>{
 const {db,sqlite}=await setup(uni);const old=globalThis.fetch;let detailCalls=0;
 globalThis.fetch=async input=>{const u=String(input);if(u==='https://t.me/robots.txt')return new Response('',{status:404});if(u==='https://t.me/s/IdlebUniversity')return new Response('<meta property="og:title" content="قناة مختلفة">');if(u.startsWith('https://news.google.com/rss/search'))return new Response('<rss></rss>');detailCalls++;throw Error('unexpected');};
 try{const result=await run(db);assert.deepEqual(result.results,[]);assert.ok(result.diagnostics.errors.some(e=>e.includes('channel identity')));assert.equal(detailCalls,0);}
 finally{globalThis.fetch=old;sqlite.close();}
});

test('a source HTTP 429 records cooldown and prevents follow-up requests',async()=>{
 const {db,sqlite}=await setup(uni);
 sqlite.prepare('INSERT INTO direct_sources(id,url,kind,name,discovered_at) VALUES(?,?,?,?,?)').run('source','https://t.me/s/IdlebUniversity','telegram','جامعة إدلب',timestamp);
 sqlite.prepare('INSERT INTO direct_source_interests(interest_key,source_id) VALUES(?,?)').run(engine.normalize(uni),'source');
 let requests=0;const fetcher=async()=>{requests++;return new Response('',{status:429,headers:{'Retry-After':'600'}});};
 try{const first=await direct.monitorDirectSources(db,uni,{fetcher});const second=await direct.monitorDirectSources(db,uni,{fetcher});
  assert.equal(first.incomplete,true);assert.equal(second.incomplete,true);assert.equal(requests,1);
  assert.ok(second.errors.some(e=>e.includes('cooldown')));
  const cooldown=sqlite.prepare("SELECT until_at FROM direct_provider_backoff WHERE provider='source:t.me'").get();
  assert.ok(Date.parse(cooldown.until_at)-Date.now()>=599000,'Retry-After must be honoured');
 }finally{sqlite.close();}
});

test('posts left after a rate limit are unprocessed rather than rejected',async()=>{
 const {db,sqlite}=await setup(uni);
 sqlite.prepare('INSERT INTO direct_sources(id,url,kind,name,discovered_at) VALUES(?,?,?,?,?)').run('source','https://t.me/s/IdlebUniversity','telegram','جامعة إدلب',timestamp);
 sqlite.prepare('INSERT INTO direct_source_interests(interest_key,source_id) VALUES(?,?)').run(engine.normalize(uni),'source');
 const post=id=>`<div class="tgme_widget_message_wrap"><div data-post="IdlebUniversity/${id}"><div class="tgme_widget_message_text">${exam}</div><time datetime="${timestamp}"></time></div></div>`;
 const fetcher=async input=>{const u=String(input);if(u==='https://t.me/robots.txt')return new Response('',{status:404});if(u==='https://t.me/s/IdlebUniversity')return new Response(`<meta property="og:title" content="جامعة إدلب">${post(1)}${post(2)}`);return new Response('',{status:429,headers:{'Retry-After':'600'}});};
 try{const result=await direct.monitorDirectSources(db,uni,{fetcher});const observation=result.observations[0];assert.equal(observation.entriesRead,2);assert.equal(observation.rejected,1);assert.equal(observation.unprocessed,1);assert.equal(result.incomplete,true);}
 finally{sqlite.close();}
});

test('Google interstitial 429 preserves Retry-After instead of trying publisher work',async()=>{
 let requests=0;
 const provenance=await engine.inspectPublisher('https://news.google.com/rss/articles/x','https://publisher.example',async()=>{requests++;return new Response('',{status:429,headers:{'Retry-After':'900'}});});
 assert.equal(provenance.resolutionStatus,'google_http_429');
 assert.equal(provenance.retryAfterSeconds,900);
 assert.equal(requests,1);
});

test('category RSS keeps its path and verifies the original publisher before notification',async()=>{
 const {db,sqlite}=await setup(infra);const old=globalThis.fetch;
 const url='https://sana.sy/governorates/edlib/123/';
 globalThis.fetch=async input=>{const u=String(input);if(u==='https://sana.sy/robots.txt')return new Response('',{status:404});if(u==='https://sana.sy/governorates/edlib/feed/')return new Response(`<rss><item><title>${road}</title><link>${url}</link><pubDate>${new Date(timestamp).toUTCString()}</pubDate><description>انطلقت أعمال تزفيت الطريق في الدانا بريف إدلب</description></item></rss>`);if(u===url)return new Response(`<meta property="og:title" content="${road}"><meta property="article:published_time" content="${timestamp}"><article>انطلقت أعمال تزفيت الطريق في مدينة الدانا بريف إدلب</article>`,{headers:{'content-type':'text/html'}});if(u.startsWith('https://news.google.com/rss/search'))return new Response('<rss></rss>');throw Error('unexpected network');};
 try{const result=await run(db);assert.equal(result.results.length,1);assert.equal(result.results[0].url,url);assert.equal(result.results[0].sourceRole,'news_agency');assert.equal(result.results[0].verification,'publisher_title_match');assert.equal((await notify.prepareNotifications(db,'a')).items.length,1);}
 finally{globalThis.fetch=old;sqlite.close();}
});

test('direct RSS checks relevant entries beyond the legacy twelve item limit',async()=>{
 const {db,sqlite}=await setup(infra),old=globalThis.fetch,url='https://sana.sy/governorates/edlib/123/';
 const unrelated=Array.from({length:12},(_,i)=>`<item><title>خبر محلي غير متعلق ${i}</title><link>https://sana.sy/other/${i}/</link><pubDate>${new Date(timestamp).toUTCString()}</pubDate></item>`).join('');
 globalThis.fetch=async input=>{const u=String(input);if(u==='https://sana.sy/robots.txt')return new Response('',{status:404});if(u==='https://sana.sy/governorates/edlib/feed/')return new Response(`<rss>${unrelated}<item><title>${road}</title><link>${url}</link><pubDate>${new Date(timestamp).toUTCString()}</pubDate><description>أعمال تزفيت الطريق في إدلب</description></item></rss>`);if(u===url)return new Response(`<meta property="og:title" content="${road}"><meta property="article:published_time" content="${timestamp}"><article>تزفيت الطريق في إدلب</article>`,{headers:{'content-type':'text/html'}});if(u.startsWith('https://news.google.com/rss/search'))return new Response('<rss></rss>');throw Error('unexpected network');};
 try{const result=await run(db);assert.equal(result.results.length,1);assert.equal(result.results[0].url,url);assert.equal(result.results[0].verification,'publisher_title_match');}
 finally{globalThis.fetch=old;sqlite.close();}
});

test('old direct items remain stored but unverified and cannot become notifications',async()=>{
 const {db,sqlite}=await setup(uni);try{
  sqlite.prepare('INSERT INTO direct_sources(id,url,kind,name,discovered_at) VALUES(?,?,?,?,?)').run('old','https://old.example','website','قديم',timestamp);
  sqlite.prepare('INSERT INTO direct_source_interests(interest_key,source_id) VALUES(?,?)').run(engine.normalize(uni),'old');
  sqlite.prepare('INSERT INTO direct_items(id,source_id,url,title,content,published_at,first_seen) VALUES(?,?,?,?,?,?,?)').run('old-item','old','https://old.example/post',exam,exam,timestamp,timestamp);
  assert.equal(sqlite.prepare("SELECT verification_status FROM direct_items WHERE id='old-item'").get().verification_status,'unverified');
  assert.equal((await notify.prepareNotifications(db,'a')).items.length,0);
  sqlite.prepare('INSERT INTO notifications(id,subscriber_id,item_kind,item_id,interest_key,title,url,status,prepared_at) VALUES(?,?,?,?,?,?,?,?,?)')
    .run('old-queued','a','direct','old-item',engine.normalize(uni),exam,'https://old.example/post','prepared',timestamp);
  const transport=notify.createMockTelegramTransport();
  assert.equal((await notify.deliverPending(db,'a',transport)).sent,0);
  assert.equal(transport.messages.length,0);
  assert.equal(sqlite.prepare("SELECT status FROM notifications WHERE id='old-queued'").get().status,'rejected');
  assert.equal(sqlite.prepare('SELECT count(*) n FROM direct_items').get().n,1);
 }finally{sqlite.close();}
});

test('migration preserves existing direct data and marks it unverified',async()=>{
 const sqlite=new DatabaseSync(':memory:');
 try{
  sqlite.exec(await readFile('schema.sql','utf8'));
  for(const file of ['0001_discovery.sql','0002_discovery_provenance.sql','0003_direct_sources.sql','0004_subscriber_interests.sql','0005_discovery_mock_flag.sql','0006_notifications.sql','0007_telegram_link_tokens.sql','0008_notification_delivery_claim.sql']) sqlite.exec(await readFile('migrations/'+file,'utf8'));
  sqlite.prepare('INSERT INTO direct_sources(id,url,kind,name,discovered_at) VALUES(?,?,?,?,?)').run('old','https://old.example','website','old',timestamp);
  sqlite.prepare('INSERT INTO direct_items(id,source_id,url,title,content,published_at,first_seen) VALUES(?,?,?,?,?,?,?)').run('item','old','https://old.example/a',exam,'original content',timestamp,timestamp);
  sqlite.exec(await readFile('migrations/0009_direct_verification.sql','utf8'));
  const row=sqlite.prepare("SELECT content,verification_status FROM direct_items WHERE id='item'").get();
  assert.equal(row.content,'original content');assert.equal(row.verification_status,'unverified');
 }finally{sqlite.close();}
});
