import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { build } from 'esbuild';
import { pathToFileURL } from 'node:url';
import { resolve } from 'node:path';
import { loadEngine, loadNotify, loadNotifyRoute, loadTelegram, openDatabase } from '../scripts/discovery-runtime.mjs';

const engine = await loadEngine();
const notify = await loadNotify();
const route = await loadNotifyRoute();
const telegram = await loadTelegram();
const digestFile = resolve('.wrangler/discovery/task16-digest.mjs');
await build({ entryPoints: ['functions/api/_digest.ts'], bundle: true, platform: 'neutral', format: 'esm', outfile: digestFile });
const digest = await import(pathToFileURL(digestFile).href);
const interest = 'قرارات البناء والتراخيص في إدلب';
const key = engine.normalize(interest);
const title = 'قرار جديد لتراخيص البناء في إدلب';
const url = 'https://news.example.org/article';

async function setup() {
  const { db, sqlite } = await openDatabase(':memory:');
  sqlite.exec(await readFile('schema.sql', 'utf8'));
  const now = new Date().toISOString();
  sqlite.prepare('INSERT INTO subscribers(id,email,status,created_at,telegram_chat_id) VALUES(?,?,?,?,?)').run('s','s@example.test','active',now,'111');
  sqlite.prepare('INSERT INTO subscriber_interests(id,subscriber_id,text,normalized_text,created_at,updated_at) VALUES(?,?,?,?,?,?)').run('i','s',interest,key,now,now);
  sqlite.prepare('INSERT INTO discovery_items(id,url,title_key,title,description,source,published_at,discovered_at,is_mock,original_url,verification_status) VALUES(?,?,?,?,?,?,?,?,?,?,?)')
    .run('item',url,'key-item',title,'تفاصيل تراخيص البناء في إدلب','مصدر',now,now,0,url,'publisher_metadata; title_match');
  sqlite.prepare('INSERT INTO discovery_item_interests(interest_key,item_id,score) VALUES(?,?,?)').run(key,'item',1);
  assert.equal((await notify.prepareNotifications(db,'s')).items.length, 1);
  return { db, sqlite, now };
}

test('queued discovery revalidation accepts valid content and permanently rejects invalid snapshots', async () => {
  const cases = [
    ['valid', () => {}, true],
    ['title mismatch', s => s.prepare("UPDATE discovery_items SET verification_status='publisher_metadata; title_mismatch' WHERE id='item'").run(), false],
    ['date mismatch', s => s.prepare("UPDATE discovery_items SET verification_status='publisher_metadata; title_match; date_mismatch' WHERE id='item'").run(), false],
    ['missing evidence', s => s.prepare("UPDATE discovery_items SET verification_status=NULL WHERE id='item'").run(), false],
    ['missing metadata evidence', s => s.prepare("UPDATE discovery_items SET verification_status='not_attempted; title_match' WHERE id='item'").run(), false],
    ['partial match token', s => s.prepare("UPDATE discovery_items SET verification_status='publisher_metadata; not_title_match' WHERE id='item'").run(), false],
    ['missing underlying record', s => s.prepare("DELETE FROM discovery_items WHERE id='item'").run(), false],
    ['mock item', s => s.prepare("UPDATE discovery_items SET is_mock=1 WHERE id='item'").run(), false],
    ['changed publisher URL', s => s.prepare("UPDATE discovery_items SET original_url='https://news.example.org/other' WHERE id='item'").run(), false],
    ['missing interest', s => s.prepare("DELETE FROM subscriber_interests WHERE id='i'").run(), false],
  ];
  for (const [label, mutate, valid] of cases) {
    const { db, sqlite } = await setup();
    try {
      mutate(sqlite);
      // Exercise both retry and expired-lease recovery, not only freshly prepared rows.
      if (!valid) sqlite.prepare("UPDATE notifications SET status='sending',claimed_at='2000-01-01T00:00:00.000Z'").run();
      const transport = notify.createMockTelegramTransport();
      const result = await notify.deliverPending(db,'s',transport);
      assert.equal(result.sent, valid ? 1 : 0, label);
      assert.equal(transport.messages.length, valid ? 1 : 0, label);
      const row = sqlite.prepare('SELECT status,sent_at,error FROM notifications').get();
      assert.equal(row.status, valid ? 'sent' : 'rejected', label);
      if (!valid) {
        assert.equal(row.sent_at,null,label);
        assert.match(row.error,/revalidation/);
        assert.equal((await notify.deliverPending(db,'s',transport)).sent,0,label);
        assert.equal(transport.messages.length,0,label);
      }
    } finally { sqlite.close(); }
  }
});

test('valid direct-source notifications remain deliverable and changed direct content is rejected', async () => {
  for (const valid of [true,false]) {
    const { db, sqlite, now } = await setup();
    try {
      sqlite.prepare('DELETE FROM notifications').run();
      sqlite.prepare('DELETE FROM discovery_item_interests').run();
      sqlite.prepare('INSERT INTO direct_sources(id,url,kind,name,discovered_at) VALUES(?,?,?,?,?)').run('source','https://direct.example.org','website','مصدر',now);
      sqlite.prepare('INSERT INTO direct_source_interests(interest_key,source_id) VALUES(?,?)').run(key,'source');
      sqlite.prepare('INSERT INTO direct_items(id,source_id,url,title,content,published_at,first_seen,verification_status) VALUES(?,?,?,?,?,?,?,?)').run('direct','source','https://direct.example.org/post',title,'قرار تنظيم تراخيص البناء في محافظة إدلب',now,now,'publisher_title_match');
      assert.equal((await notify.prepareNotifications(db,'s')).items.length,1);
      if (!valid) sqlite.prepare("UPDATE direct_items SET content='رياضة حلب', title='مباراة في حلب' WHERE id='direct'").run();
      const transport = notify.createMockTelegramTransport();
      assert.equal((await notify.deliverPending(db,'s',transport)).sent,valid ? 1 : 0);
      assert.equal(sqlite.prepare('SELECT status FROM notifications').get().status,valid ? 'sent' : 'rejected');
    } finally { sqlite.close(); }
  }
});

test('mixed valid and invalid queued items deliver only the valid item, including failed retries', async () => {
  const { db, sqlite, now } = await setup();
  try {
    const badUrl='https://news.example.org/bad';
    sqlite.prepare('INSERT INTO discovery_items(id,url,title_key,title,source,published_at,discovered_at,is_mock,original_url,verification_status) VALUES(?,?,?,?,?,?,?,?,?,?)')
      .run('bad',badUrl,'key-bad','عنوان آخر','مصدر',now,now,0,badUrl,'publisher_metadata; title_match; date_mismatch');
    sqlite.prepare('INSERT INTO discovery_item_interests(interest_key,item_id,score) VALUES(?,?,?)').run(key,'bad',1);
    sqlite.prepare('INSERT INTO notifications(id,subscriber_id,item_kind,item_id,interest_key,title,url,status,prepared_at) VALUES(?,?,?,?,?,?,?,?,?)')
      .run('bad-notification','s','discovery','bad',key,'عنوان آخر',badUrl,'failed',now);
    const transport=notify.createMockTelegramTransport();
    assert.equal((await notify.deliverPending(db,'s',transport)).sent,1);
    assert.equal(transport.messages.length,1);
    assert.match(transport.messages[0],/قرار جديد لتراخيص البناء/);
    assert.doesNotMatch(transport.messages[0],/عنوان آخر/);
    assert.equal(sqlite.prepare("SELECT status FROM notifications WHERE id='bad-notification'").get().status,'rejected');
  } finally {sqlite.close();}
});

test('the actual enabled route never calls Telegram for rejected content or an ineligible subscriber', async () => {
  for (const mutation of ["UPDATE discovery_items SET verification_status='publisher_metadata; title_mismatch'", "UPDATE subscribers SET status='cancelled'"]) {
    const { db, sqlite } = await setup();
    const original = globalThis.fetch; let calls = 0;
    globalThis.fetch = async () => { calls++; throw new Error('network forbidden'); };
    try {
      sqlite.prepare(mutation).run();
      const request = new Request('https://example.test/api/notify',{method:'POST',headers:{'x-cron-secret':'local-secret','content-type':'application/json'},body:JSON.stringify({mode:'deliver'})});
      const result = await route.onRequestPost({request,env:{DB:db,CRON_SECRET:'local-secret',TELEGRAM_DELIVERY_ENABLED:'1',TELEGRAM_TEST_CHAT_IDS:'111',TELEGRAM_BOT_TOKEN:'local-token'},params:{},waitUntil(){}});
      assert.equal(result.status,200);
      assert.equal(calls,0);
    } finally { globalThis.fetch=original; sqlite.close(); }
  }
});

test('legacy scheduled digest rejects historical group IDs, keeps private delivery and email behavior', async () => {
  const { db, sqlite } = await openDatabase(':memory:'); sqlite.exec(await readFile('schema.sql','utf8'));
  const now = new Date().toISOString();
  for (const [id,chat] of [['group','-100123'],['private','111'],['email',null]]) {
    sqlite.prepare('INSERT INTO subscribers(id,email,status,created_at,telegram_chat_id) VALUES(?,?,?,?,?)').run(id,id+'@example.test','active',now,chat);
    sqlite.prepare('INSERT INTO subscriber_topics(subscriber_id,topic) VALUES(?,?)').run(id,'politics');
  }
  sqlite.prepare('INSERT INTO articles(id,title,url,source,topic,scope,published_at,fetched_at) VALUES(?,?,?,?,?,?,?,?)').run('a','خبر سوري','https://example.org/news','مصدر','politics','syria',now,now);
  const original=globalThis.fetch, calls=[];
  globalThis.fetch=async (input,init)=>{ const target=String(input); assert.ok(target.startsWith('https://api.telegram.org/') || target.startsWith('https://api.brevo.com/')); calls.push({target,body:JSON.parse(init.body)}); return new Response('{}',{status:200}); };
  try {
    const result=await digest.runDigest({DB:db,TELEGRAM_BOT_TOKEN:'local-token',BREVO_API_KEY:'local-key',SENDER_EMAIL:'sender@example.test'},true);
    const telegramCalls=calls.filter(x=>x.target.startsWith('https://api.telegram.org/'));
    assert.deepEqual(telegramCalls.map(x=>String(x.body.chat_id)),['111']);
    assert.equal(calls.filter(x=>x.target.startsWith('https://api.brevo.com/')).length,1);
    assert.equal(result.details.find(x=>x.email==='group@example.test').status,'telegram_invalid_recipient');
    assert.equal(sqlite.prepare("SELECT telegram_chat_id FROM subscribers WHERE id='group'").get().telegram_chat_id,'-100123');
  } finally { globalThis.fetch=original; sqlite.close(); }
});

test('/news ignores groups, channels and mismatched senders, while a matching private user receives news', async () => {
  const { db, sqlite } = await openDatabase(':memory:'); sqlite.exec(await readFile('schema.sql','utf8'));
  const now=new Date().toISOString();
  for (const [id,chat] of [['private','111'],['group','-100123'],['super','-100456']]) {
    sqlite.prepare('INSERT INTO subscribers(id,email,status,created_at,telegram_chat_id) VALUES(?,?,?,?,?)').run(id,id+'@example.test','active',now,chat);
    sqlite.prepare('INSERT INTO subscriber_topics(subscriber_id,topic) VALUES(?,?)').run(id,'politics');
  }
  sqlite.prepare('INSERT INTO articles(id,title,url,source,topic,scope,published_at,fetched_at) VALUES(?,?,?,?,?,?,?,?)').run('a','خبر سوري خاص بالاختبار','https://example.org/news','مصدر','politics','syria',now,now);
  sqlite.prepare('INSERT INTO telegram_link_tokens(token,subscriber_id,created_at,expires_at) VALUES(?,?,?,?)').run('link-token','private',now,'2999-01-01T00:00:00.000Z');
  const original=globalThis.fetch, calls=[];
  globalThis.fetch=async (input,init)=>{assert.ok(String(input).startsWith('https://api.telegram.org/'));calls.push(JSON.parse(init.body));return new Response('{}',{status:200});};
  const webhook=async update=>telegram.onRequestPost({request:new Request('https://example.test/api/telegram',{method:'POST',headers:{'x-telegram-bot-api-secret-token':'local-secret','content-type':'application/json'},body:JSON.stringify(update)}),env:{DB:db,TELEGRAM_BOT_TOKEN:'local-token',TELEGRAM_WEBHOOK_SECRET:'local-secret'},params:{},waitUntil(){}});
  try {
    await webhook({message:{text:'/news',chat:{id:-100123,type:'group'},from:{id:111}}});
    await webhook({message:{text:'/news',chat:{id:-100456,type:'supergroup'},from:{id:111}}});
    await webhook({channel_post:{text:'/news',chat:{id:-100789,type:'channel'}}});
    await webhook({message:{text:'/news',chat:{id:111,type:'private'},from:{id:222}}});
    await webhook({message:{text:'/start link-token',chat:{id:-100123,type:'group'},from:{id:111}}});
    assert.equal(calls.length,0);
    assert.equal(sqlite.prepare("SELECT used_at FROM telegram_link_tokens WHERE token='link-token'").get().used_at,null);
    await webhook({message:{text:'/news',chat:{id:111,type:'private'},from:{id:111}}});
    assert.equal(calls.length,1);
    assert.equal(String(calls[0].chat_id),'111');
    assert.match(calls[0].text,/خبر سوري خاص بالاختبار/);
  } finally {globalThis.fetch=original; sqlite.close();}
});

test('/news prevents legacy digest for beta and expired subscribers', async () => {
  const {db,sqlite}=await openDatabase(':memory:');sqlite.exec(await readFile('schema.sql','utf8'));
  const now=new Date().toISOString();
  for(const [id,chat,expiry] of [['beta','111',null],['expired','222','2000-01-01T00:00:00.000Z']]){
    sqlite.prepare('INSERT INTO subscribers(id,email,status,created_at,telegram_chat_id,expires_at) VALUES(?,?,?,?,?,?)').run(id,id+'@example.test','active',now,chat,expiry);
    sqlite.prepare('INSERT INTO subscriber_topics(subscriber_id,topic) VALUES(?,?)').run(id,'politics');
  }
  sqlite.prepare('INSERT INTO beta_identities(chat_id,subscriber_id,created_at,created_beta) VALUES(?,?,?,?)').run('111','beta',now,1);
  sqlite.prepare('INSERT INTO articles(id,title,url,source,topic,scope,published_at,fetched_at) VALUES(?,?,?,?,?,?,?,?)').run('a','خبر لا يخص الاهتمام','https://example.org/news','مصدر','politics','syria',now,now);
  const old=globalThis.fetch,calls=[];globalThis.fetch=async (_u,init)=>{calls.push(JSON.parse(init.body));return new Response('{}');};
  try{for(const id of [111,222]){const request=new Request('https://example.test/api/telegram',{method:'POST',headers:{'x-telegram-bot-api-secret-token':'local-secret','content-type':'application/json'},body:JSON.stringify({message:{text:'/news',chat:{id,type:'private'},from:{id}}})});await telegram.onRequestPost({request,env:{DB:db,TELEGRAM_BOT_TOKEN:'local-token',TELEGRAM_WEBHOOK_SECRET:'local-secret'},params:{},waitUntil(){}});}
    assert.equal(calls.length,2);assert.ok(calls.every(x=>!x.text.includes('خبر لا يخص الاهتمام')));
    assert.equal(sqlite.prepare('SELECT COUNT(*) n FROM digests').get().n,0);
  }finally{globalThis.fetch=old;sqlite.close();}
});
