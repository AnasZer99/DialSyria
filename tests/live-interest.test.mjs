import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { loadInterestDiscovery, loadNotify, openDatabase } from '../scripts/discovery-runtime.mjs';
import { loadEngine } from '../scripts/discovery-runtime.mjs';

const route = await loadInterestDiscovery();
const notify = await loadNotify();
const engine = await loadEngine();
const interest = 'قرارات البناء والتراخيص في إدلب';
const good = 'قرار تراخيص البناء في إدلب';
const bad = 'قرار تراخيص البناء في حلب';
const mismatch = 'تراخيص البناء الجديدة في إدلب';
const origin = 'https://publisher.example';

async function setup() {
  const { db, sqlite } = await openDatabase(':memory:');
  sqlite.exec(await readFile('schema.sql','utf8'));
  sqlite.prepare('INSERT INTO subscribers(id,email,status,created_at,magic_token,magic_expires) VALUES(?,?,?,?,?,?)').run('a','a@example.test','active','2026-01-01','token-a','2999-01-01');
  sqlite.prepare('INSERT INTO subscribers(id,email,status,created_at,magic_token,magic_expires) VALUES(?,?,?,?,?,?)').run('b','b@example.test','active','2026-01-01','token-b','2999-01-01');
  sqlite.prepare('INSERT INTO subscriber_interests(id,subscriber_id,text,normalized_text,created_at,updated_at) VALUES(?,?,?,?,?,?)').run('i','a',interest,'normalized','2026-01-01','2026-01-01');
  return {db,sqlite};
}

async function call(db, token='token-a', mode='live', id='i', extra={}) {
  const request=new Request('https://example.test/api/interests/discover',{method:'POST',headers:{authorization:'Bearer '+token,'content-type':'application/json'},body:JSON.stringify({id,mode,subscriber_id:'b',text:'untrusted'})});
  const response=await route.onRequestPost({request,env:{DB:db,...extra},params:{},waitUntil(){}});
  return {status:response.status,body:await response.json()};
}

function fakeSearch() {
  let calls=0;
  const now=new Date().toUTCString(), iso=new Date().toISOString();
  const entry=(title,path)=>`<item><title>${title}</title><link>${origin}/${path}</link><pubDate>${now}</pubDate><description>${path==='bad' ? 'قرار البناء في حلب' : 'قرارات تراخيص البناء وتنظيم العمران في إدلب'}</description><source url="${origin}">ناشر محلي</source></item>`;
  return {get calls(){return calls;},fetch:async input=>{
    calls++; const u=new URL(String(input));
    if (u.hostname==='news.google.com') return new Response(`<rss><channel>${entry(good,'good')}${entry(bad,'bad')}${entry(mismatch,'mismatch')}</channel></rss>`,{status:200});
    if (u.hostname==='publisher.example' && u.pathname==='/robots.txt') return new Response('',{status:404});
    if (u.hostname==='publisher.example' && u.pathname==='/feed/') return new Response('',{status:404});
    if (u.hostname==='publisher.example') {
      const pageTitle=u.pathname==='/mismatch' ? 'أخبار الرياضة في دمشق' : good;
      return new Response(`<meta property="og:title" content="${pageTitle}"><meta property="article:published_time" content="${iso}">`,{status:200,headers:{'content-type':'text/html'}});
    }
    throw new Error('unexpected network access');
  }};
}

test('live discovery enforces ownership and returns only verified current publisher results', async () => {
  const {db,sqlite}=await setup(); const original=globalThis.fetch, fake=fakeSearch(); globalThis.fetch=fake.fetch;
  try {
    assert.equal((await call(db,'token-b')).status,404);
    assert.equal((await call(db,'wrong')).status,401);
    assert.equal(fake.calls,0);
    const result=await call(db);
    assert.equal(result.status,200);
    assert.equal(result.body.mode,'live');
    assert.equal(result.body.interest,interest);
    assert.ok(result.body.diagnostics.found>0);
    assert.ok(result.body.diagnostics.rejected>0);
    assert.equal(result.body.results.length,1);
    assert.equal(result.body.results[0].url,origin+'/good');
    assert.equal(result.body.results[0].sourceType,'website');
    assert.match(result.body.results[0].verification,/title_match/);
    assert.ok(result.body.diagnostics.duplicates>0);
    assert.ok(fake.calls<=24);
    const prepared=await notify.prepareNotifications(db,'a');
    assert.equal(prepared.items.length,1);
    assert.equal(prepared.items[0].url,origin+'/good');
    const repeated=await call(db);
    assert.equal(repeated.status,200);
    assert.equal(repeated.body.results.length,1);
    assert.ok(repeated.body.diagnostics.errors.length>0, 'an unavailable newly discovered source is reported on the next monitoring run');
    assert.equal(repeated.body.diagnostics.incomplete,true);
    assert.equal(sqlite.prepare('SELECT count(*) n FROM discovery_items WHERE url=?').get(origin+'/good').n,1);
  } finally {globalThis.fetch=original;sqlite.close();}
});

test('live mode is separate from mock data and reports empty results and provider errors', async () => {
  const {db,sqlite}=await setup(); const original=globalThis.fetch; let calls=0;
  globalThis.fetch=async()=>{calls++;return new Response('',{status:429,headers:{'Retry-After':'300'}});};
  try {
    const mock=await call(db,'token-a','mock','i',{ALLOW_MOCK_DISCOVERY:'1'});
    assert.equal(mock.status,200); assert.equal(mock.body.report.mock,true); assert.equal(calls,0);
    const live=await call(db);
    assert.equal(live.status,200); assert.equal(live.body.mode,'live');
    assert.deepEqual(live.body.results,[]); assert.equal(live.body.diagnostics.directlyVerified,0);
    assert.ok(live.body.diagnostics.errors.some(e=>e.includes('429')));
    const after=await call(db);
    assert.equal(after.status,200); assert.deepEqual(after.body.results,[]);
    assert.equal(calls,1, 'cooldown must prevent an immediate retry');
    assert.equal((await call(db)).status,200);
    assert.equal((await call(db)).status,429);
  } finally {globalThis.fetch=original;sqlite.close();}
});

test('live monitoring returns an existing public Telegram source and its post can be prepared', async () => {
  const {db,sqlite}=await setup(); const original=globalThis.fetch;
  const now=new Date().toISOString();
  sqlite.prepare('INSERT INTO direct_sources(id,url,kind,name,discovered_at) VALUES(?,?,?,?,?)').run('channel','https://t.me/s/examplechan','telegram','قناة عامة',now);
  sqlite.prepare('INSERT INTO direct_source_interests(interest_key,source_id) VALUES(?,?)').run(engine.normalize(interest),'channel');
  globalThis.fetch=async input=>{
    const url=String(input);
    if(url.startsWith('https://news.google.com/rss/search'))return new Response('<rss><channel></channel></rss>');
    if(url==='https://t.me/robots.txt')return new Response('User-agent: *\nAllow: /');
    if(url==='https://t.me/s/examplechan' || url==='https://t.me/s/examplechan/123')return new Response(`<div class="tgme_widget_message_wrap"><div data-post="examplechan/123"><div class="tgme_widget_message_text">${good}</div><time datetime="${now}"></time></div></div>`);
    throw new Error('unexpected external request');
  };
  try {
    const result=await call(db);
    assert.equal(result.status,200);
    assert.equal(result.body.results.length,1);
    assert.equal(result.body.results[0].url,'https://t.me/examplechan/123');
    assert.equal(result.body.results[0].sourceType,'telegram');
    assert.equal(result.body.results[0].verification,'telegram_post_verified');
    const prepared=await notify.prepareNotifications(db,'a');
    assert.equal(prepared.items.length,1);
    assert.equal(prepared.items[0].url,'https://t.me/examplechan/123');
  } finally {globalThis.fetch=original;sqlite.close();}
});
