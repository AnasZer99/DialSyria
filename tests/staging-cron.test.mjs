import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import worker from '../cron-worker/staging.js';
import { loadDirectRoute, loadBetaScheduledRoute, loadInterests, openDatabase } from '../scripts/discovery-runtime.mjs';

const cron = '*/30 * * * *';
const secret = 'local-test-secret-0123456789-abcdef';
const env = { STAGING_SCHEDULER_ENABLED: '1', CRON_SECRET: secret };
const target = 'https://dialsyria-staging.pages.dev/api/direct';
async function tick(overrides = {}, eventCron = cron) {
  const pending = [];
  worker.scheduled({ cron: eventCron }, { ...env, ...overrides }, { waitUntil: p => pending.push(p) });
  await Promise.all(pending);
}

test('staging config is isolated and scheduling is disabled by default', async () => {
  const config = JSON.parse(await readFile('cron-worker/wrangler.staging.jsonc', 'utf8'));
  assert.equal(config.name, 'dialsyria-staging-interest-cron');
  assert.equal(config.account_id, '3536c8fe2de7b854a7295fb495763935');
  assert.equal(config.main, 'staging.js');
  assert.equal(config.workers_dev, false);
  assert.deepEqual(config.compatibility_flags, ['global_fetch_strictly_public']);
  assert.deepEqual(config.triggers.crons, []);
  assert.equal(config.vars.STAGING_SCHEDULER_ENABLED, '0');
  assert.equal(config.vars.STAGING_BETA_PREPARATION_ENABLED, '0');
  assert.equal(config.vars.STAGING_BATCH_SWEEP_ENABLED, '0');
  assert.equal(config.d1_databases, undefined);
  assert.equal(config.vars.CRON_SECRET, undefined);
  assert.equal(worker.fetch, undefined);
});

test('disabled worker, different schedules and absent or weak secrets do not issue requests', async () => {
  const old = globalThis.fetch, oldError = console.error; let calls = 0;
  globalThis.fetch = async () => { calls++; throw Error('unexpected network'); };
  console.error = () => {};
  try {
    await tick({ STAGING_SCHEDULER_ENABLED: '0' });
    await tick({ STAGING_SCHEDULER_ENABLED: undefined });
    await tick({}, '7 * * * *');
    await tick({ CRON_SECRET: undefined });
    await tick({ CRON_SECRET: 'short' });
    assert.equal(calls, 0);
  } finally { globalThis.fetch = old; console.error = oldError; }
});

test('only the fixed staging sweep endpoint is called once and redirects are blocked', async () => {
  const old = globalThis.fetch, requests = [];
  globalThis.fetch = async (url, init) => { requests.push({ url, init }); return Response.json({ checked: 0 }); };
  try {
    await tick({ SITE_URL: 'https://dial-syria.pages.dev', TELEGRAM_DELIVERY_ENABLED: '1' });
    assert.equal(requests.length, 1);
    const { url, init } = requests[0];
    assert.equal(url, target); assert.equal(init.method, 'POST');
    assert.deepEqual(JSON.parse(init.body), { mode: 'sweep' });
    assert.equal(init.headers['x-cron-secret'], secret);
    assert.equal(init.redirect, 'manual'); assert.ok(init.signal instanceof AbortSignal);
  } finally { globalThis.fetch = old; }
});

test('opted-in scheduler prepares beta after monitoring without calling delivery paths',async()=>{
 const old=globalThis.fetch,calls=[];
 globalThis.fetch=async(url,init)=>{calls.push({url:String(url),init});return Response.json({checked:0});};
 try{await tick({STAGING_BETA_PREPARATION_ENABLED:'1'});
  assert.deepEqual(calls.map(x=>x.url),[target,'https://dialsyria-staging.pages.dev/api/beta-scheduled']);
  assert.ok(calls.every(x=>x.init.redirect==='manual' && x.init.headers['x-cron-secret']===secret));
  assert.ok(!calls.some(x=>x.url.includes('api.telegram.org')||/\/api\/(notify|digest|ingest)/.test(x.url)));
 }finally{globalThis.fetch=old;}
});

test('bounded batch starts another sweep only with a full remaining budget',async()=>{
 const old=globalThis.fetch,oldNow=Date.now;let now=Date.now(),calls=0;Date.now=()=>now;
 try{
  globalThis.fetch=async()=>{calls++;return Response.json({checked:calls===1?1:0});};
  await tick({STAGING_BATCH_SWEEP_ENABLED:'1'});assert.equal(calls,2);
  calls=0;globalThis.fetch=async()=>{calls++;now+=6000;return Response.json({checked:1});};
  await tick({STAGING_BATCH_SWEEP_ENABLED:'1'});assert.equal(calls,1);
  calls=0;globalThis.fetch=async()=>{calls++;return Response.json({checked:1,incomplete:true});};
  const log=console.error;console.error=()=>{};try{await tick({STAGING_BATCH_SWEEP_ENABLED:'1'});}finally{console.error=log;}assert.equal(calls,1);
 }finally{globalThis.fetch=old;Date.now=oldNow;}
});

test('HTTP 429 and transport errors never retry or expose credentials', async () => {
  const old = globalThis.fetch, oldError = console.error, messages = []; let calls = 0;
  console.error = (...args) => messages.push(args.join(' '));
  try {
    globalThis.fetch = async () => { calls++; return new Response('', { status: 429 }); };
    await tick();
    globalThis.fetch = async () => { calls++; throw Error('unsafe error containing ' + secret); };
    await tick();
    assert.equal(calls, 2); assert.match(messages[0], /429/);
    assert.ok(messages.every(message => !message.includes(secret)));
  } finally { globalThis.fetch = old; console.error = oldError; }
});

test('a successful HTTP response reports an incomplete sweep without logging content', async () => {
  const old = globalThis.fetch, oldError = console.error, messages = [];
  globalThis.fetch = async () => Response.json({ checked: 1, incomplete: true, errorCode: 'rate_limited', interest: 'private interest' });
  console.error = (...args) => messages.push(args.join(' '));
  try {
    await tick();
    assert.equal(messages.length, 1); assert.match(messages[0], /incomplete/);
    assert.ok(!messages[0].includes('private interest'));
  } finally { globalThis.fetch = old; console.error = oldError; }
});

test('distinguishes timeout, redirect, transport and invalid response without exposing secrets', async () => {
  const oldFetch = globalThis.fetch, oldError = console.error, oldTimeout = AbortSignal.timeout, messages = [];
  console.error = (...args) => messages.push(args.join(' '));
  try {
    AbortSignal.timeout = () => AbortSignal.abort();
    globalThis.fetch = async () => { throw Error('timeout ' + secret); };
    await tick();
    AbortSignal.timeout = oldTimeout;
    globalThis.fetch = async () => new Response(null, { status: 302, headers: { location: 'https://attacker.invalid/?secret=' + secret } });
    await tick();
    globalThis.fetch = async () => { throw Error('network ' + secret); };
    await tick();
    globalThis.fetch = async () => new Response('not JSON ' + secret);
    await tick();
    globalThis.fetch = async () => Response.json({ token: secret });
    await tick();
    assert.match(messages[0], /timeout/); assert.match(messages[1], /HTTP 302/);
    assert.match(messages[2], /transport error/); assert.match(messages[3], /invalid response/);
    assert.match(messages[4], /invalid response/);
    assert.ok(messages.every(message => !message.includes(secret) && !message.includes('attacker.invalid')));
  } finally { globalThis.fetch = oldFetch; console.error = oldError; AbortSignal.timeout = oldTimeout; }
});

test('two staging cron ticks reach isolated Phase A without duplicates or Telegram sends', async () => {
  const route = await loadDirectRoute(), interests = await loadInterests();
  const { db, sqlite } = await openDatabase(':memory:'); sqlite.exec(await readFile('schema.sql', 'utf8'));
  const now = new Date().toISOString(), interest = 'أخبار وإعلانات جامعة إدلب';
  sqlite.prepare('INSERT INTO subscribers(id,email,telegram_chat_id,status,created_at,magic_token,magic_expires) VALUES(?,?,?,?,?,?,?)')
    .run('beta_a', 'a@example.invalid', '101', 'active', now, 'local-token', '2999-01-01T00:00:00.000Z');
  sqlite.prepare('INSERT INTO beta_identities(chat_id,subscriber_id,created_at,created_beta,notifications_enabled_at) VALUES(?,?,?,?,?)')
    .run('101', 'beta_a', now, 1, now);
  const pageEnv = { DB: db, CRON_SECRET: secret, BETA_ALLOWED_TELEGRAM_IDS: '101' };
  const ctx = (request, e) => ({ request, env: e, params: {}, waitUntil() {} });
  const add = new Request('https://local.invalid/api/interests', { method: 'POST', headers: { authorization: 'Bearer local-token', 'content-type': 'application/json' }, body: JSON.stringify({ text: interest }) });
  assert.equal((await interests.onRequestPost(ctx(add, pageEnv))).status, 201);
  const page = `<meta property="og:title" content="جامعة إدلب"><div class="tgme_widget_message_wrap"><div data-post="IdlebUniversity/123"><div class="tgme_widget_message_text">تعلن كلية الطب بدء الفصل الدراسي الجديد للطلاب</div><time datetime="${now}"></time></div></div>`;
  const old = globalThis.fetch, calls = [];
  globalThis.fetch = async (url, init) => {
    const u = String(url); calls.push(u);
    if (u === target) return route.onRequestPost(ctx(new Request(u, init), pageEnv));
    if (u === 'https://t.me/robots.txt') return new Response('', { status: 404 });
    if (u === 'https://t.me/s/IdlebUniversity' || u === 'https://t.me/s/IdlebUniversity/123') return new Response(page);
    if (u.startsWith('https://news.google.com/rss/search')) return new Response('<rss><channel></channel></rss>');
    throw Error('unexpected network');
  };
  try {
    await tick(); await tick();
    assert.equal(calls.filter(u => u === target).length, 2);
    assert.equal(sqlite.prepare('SELECT count(*) n FROM interest_monitor_jobs').get().n, 1);
    assert.equal(sqlite.prepare('SELECT count(*) n FROM direct_items').get().n, 1);
    assert.equal(sqlite.prepare('SELECT count(*) n FROM notifications').get().n, 0);
    assert.ok(!calls.some(u => u.includes('api.telegram.org') || /\/api\/(notify|digest|ingest)/.test(u)));
  } finally { globalThis.fetch = old; sqlite.close(); }
});

test('scheduled monitoring, verified storage, preparation and mocked delivery run once end to end',async()=>{
 const route=await loadDirectRoute(),scheduled=await loadBetaScheduledRoute(),interests=await loadInterests();
 const {db,sqlite}=await openDatabase(':memory:');sqlite.exec(await readFile('schema.sql','utf8'));
 const baseline=new Date(Date.now()-60000).toISOString(),now=new Date().toISOString(),interest='أخبار وإعلانات جامعة إدلب';
 sqlite.prepare('INSERT INTO subscribers(id,email,telegram_chat_id,status,created_at,magic_token,magic_expires) VALUES(?,?,?,?,?,?,?)').run('beta_a','a@example.invalid','101','active',baseline,'local-token','2999-01-01T00:00:00.000Z');
 sqlite.prepare('INSERT INTO beta_identities(chat_id,subscriber_id,created_at,created_beta,notifications_enabled_at) VALUES(?,?,?,?,?)').run('101','beta_a',baseline,1,baseline);
 const pageEnv={DB:db,CRON_SECRET:secret,BETA_ALLOWED_TELEGRAM_IDS:'101',TELEGRAM_TEST_CHAT_IDS:'101',TELEGRAM_BOT_TOKEN:'mock',TELEGRAM_DELIVERY_ENABLED:'1',BETA_SCHEDULED_DELIVERY_ENABLED:'1'};
 const context=(request,env)=>({request,env,params:{},waitUntil(){}});
 const add=new Request('https://local.invalid/api/interests',{method:'POST',headers:{authorization:'Bearer local-token','content-type':'application/json'},body:JSON.stringify({text:interest})});
 assert.equal((await interests.onRequestPost(context(add,pageEnv))).status,201);
 await new Promise(resolve=>setTimeout(resolve,20));const postDate=new Date().toISOString();
 const page=`<meta property="og:title" content="جامعة إدلب"><div class="tgme_widget_message_wrap"><div data-post="IdlebUniversity/123"><div class="tgme_widget_message_text">تعلن كلية الطب بدء الفصل الدراسي الجديد للطلاب</div><time datetime="${postDate}"></time></div></div>`;
 const old=globalThis.fetch,sends=[];
 globalThis.fetch=async(url,init)=>{const u=String(url);
  if(u===target)return route.onRequestPost(context(new Request(u,init),pageEnv));
  if(u==='https://dialsyria-staging.pages.dev/api/beta-scheduled')return scheduled.onRequestPost(context(new Request(u,init),pageEnv));
  if(u==='https://t.me/robots.txt')return new Response('',{status:404});
  if(u==='https://t.me/s/IdlebUniversity'||u==='https://t.me/s/IdlebUniversity/123')return new Response(page);
  if(u.startsWith('https://news.google.com/rss/search'))return new Response('<rss><channel></channel></rss>');
  if(u.startsWith('https://api.telegram.org/')){sends.push(JSON.parse(init.body));return new Response('{"ok":true}');}
  throw Error('unexpected external request');};
 try{await tick({STAGING_BETA_PREPARATION_ENABLED:'1'});await tick({STAGING_BETA_PREPARATION_ENABLED:'1'});
  assert.equal(sqlite.prepare('SELECT count(*) n FROM direct_items').get().n,1);
  assert.equal(sends.length,1);assert.equal(String(sends[0].chat_id),'101');assert.equal(sqlite.prepare("SELECT count(*) n FROM notifications WHERE status='sent'").get().n,1);
 }finally{globalThis.fetch=old;sqlite.close();}
});
