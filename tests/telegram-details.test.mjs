import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { loadEngine, loadInterests, loadNotify, loadTelegram, openDatabase } from '../scripts/discovery-runtime.mjs';

const api = await loadInterests();
const engine = await loadEngine();
const notify = await loadNotify();
const telegram = await loadTelegram();

const IDLIB = 'قرارات البناء والتراخيص في إدلب';
const ALEPPO = 'أخبار الكهرباء في حلب';

function stubTelegram() {
  const messages = [];
  const original = globalThis.fetch;
  globalThis.fetch = async (input, init) => {
    const href = String(input);
    if (!href.startsWith('https://api.telegram.org/')) throw new Error('blocked external fetch: ' + href);
    const body = init && typeof init.body === 'string' ? JSON.parse(init.body) : {};
    messages.push({ chatId: String(body.chat_id), text: String(body.text || '') });
    return new Response(JSON.stringify({ ok: true }), { status: 200 });
  };
  return { messages, restore: () => { globalThis.fetch = original; } };
}

async function webhook(db, text, chatId) {
  const req = new Request('https://example.test/api/telegram', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-telegram-bot-api-secret-token': 'whsec' },
    body: JSON.stringify({ message: { text, chat: { id: chatId } } }),
  });
  await telegram.onRequestPost({ request: req, env: { DB: db, TELEGRAM_BOT_TOKEN: 'test-token', TELEGRAM_WEBHOOK_SECRET: 'whsec' }, params: {}, waitUntil() {} });
}

async function setup() {
  const { db, sqlite } = await openDatabase(':memory:');
  sqlite.exec(await readFile('schema.sql', 'utf8'));
  for (const [id, chat] of [['a', '111'], ['b', '222']]) {
    sqlite.prepare('INSERT INTO subscribers (id,email,status,created_at,telegram_chat_id) VALUES (?,?,?,?,?)').run(id, id + '@example.test', 'active', '2026-01-01', chat);
  }
  const interest = (sub, text) =>
    sqlite.prepare('INSERT INTO subscriber_interests (id,subscriber_id,text,normalized_text,created_at,updated_at) VALUES (?,?,?,?,?,?)')
      .run('int-' + sub, sub, text, api.normalizeInterest(text), '2026-01-01', '2026-01-01');
  interest('a', IDLIB);
  interest('b', ALEPPO);
  const item = (id, title, description, publishedAt, key) => {
    sqlite.prepare('INSERT INTO discovery_items (id,url,title_key,title,description,source,published_at,discovered_at,source_host,is_mock,publisher_published_at,original_url,verification_status) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)')
      .run(id, 'https://news.example.org/' + id, 'key-' + id, title, description, 'سانا', publishedAt, '2026-11-21T00:00:00.000Z', 'news.example.org', 0, publishedAt, 'https://news.example.org/' + id, 'publisher_metadata; title_match');
    sqlite.prepare('INSERT INTO discovery_item_interests (interest_key,item_id,score) VALUES (?,?,?)').run(key, id, 0.9);
  };
  item('det-a', 'قرار جديد لتراخيص البناء في إدلب', 'أصدرت الجهات المختصة قراراً يحدد ضوابط تراخيص البناء في محافظة إدلب.', '2026-11-20T09:00:00.000Z', engine.normalize(IDLIB));
  item('det-a-empty', 'متابعة تراخيص البناء في إدلب', null, null, engine.normalize(IDLIB));
  item('det-b', 'تحسن واقع الكهرباء في حلب', 'شهدت أحياء حلب تحسناً في ساعات التغذية.', '2026-11-19T12:00:00.000Z', engine.normalize(ALEPPO));
  await notify.prepareNotifications(db, 'a');
  await notify.prepareNotifications(db, 'b');
  const notificationId = (sub, itemId) => sqlite.prepare('SELECT id FROM notifications WHERE subscriber_id=? AND item_id=?').get(sub, itemId).id;
  return { db, sqlite, aDetails: notificationId('a', 'det-a'), aDateless: notificationId('a', 'det-a-empty'), bDetails: notificationId('b', 'det-b') };
}

test('/more returns stored details for the linked subscriber', async () => {
  const { db, sqlite, aDetails } = await setup();
  const stub = stubTelegram();
  try {
    await webhook(db, '/more ' + aDetails, 111);
    const message = stub.messages.at(-1);
    assert.ok(message);
    assert.equal(message.chatId, '111');
    assert.match(message.text, /قرار جديد لتراخيص البناء في إدلب/);
    assert.match(message.text, /سانا/);
    assert.match(message.text, /2026-11-20/);
    assert.match(message.text, /https:\/\/news\.example\.org\/det-a/);
    assert.match(message.text, /ضوابط تراخيص البناء/);
  } finally { stub.restore(); sqlite.close(); }
});

test('missing, unknown and foreign references are handled safely', async () => {
  const { db, sqlite, bDetails } = await setup();
  const stub = stubTelegram();
  try {
    await webhook(db, '/more', 111);
    assert.match(stub.messages.at(-1).text, /\/more <معرف التحديث>/);

    await webhook(db, '/more unknown-id', 111);
    assert.match(stub.messages.at(-1).text, /لا يوجد تحديث بهذا المعرف يخص حسابك/);

    // Another subscriber's notification must not be disclosed.
    await webhook(db, '/more ' + bDetails, 111);
    const foreign = stub.messages.at(-1).text;
    assert.match(foreign, /لا يوجد تحديث بهذا المعرف يخص حسابك/);
    assert.ok(!foreign.includes('الكهرباء'));

    // Unlinked chat.
    await webhook(db, '/more ' + bDetails, 999);
    assert.match(stub.messages.at(-1).text, /حسابك غير مرتبط بعد/);
  } finally { stub.restore(); sqlite.close(); }
});

test('/more never invents missing fields', async () => {
  const { db, sqlite, aDateless } = await setup();
  const stub = stubTelegram();
  try {
    await webhook(db, '/more ' + aDateless, 111);
    const message = stub.messages.at(-1).text;
    assert.match(message, /متابعة تراخيص البناء في إدلب/);
    assert.match(message, /سانا/);
    assert.match(message, /https:\/\/news\.example\.org\/det-a-empty/);
    assert.ok(!/\d{4}-\d{2}-\d{2}/.test(message));
  } finally { stub.restore(); sqlite.close(); }
});
