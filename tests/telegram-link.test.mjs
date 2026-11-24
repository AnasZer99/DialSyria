import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { loadTelegram, loadTelegramLink, openDatabase } from '../scripts/discovery-runtime.mjs';

const linkApi = await loadTelegramLink();
const telegram = await loadTelegram();

async function setup() {
  const { db, sqlite } = await openDatabase(':memory:');
  sqlite.exec(await readFile('schema.sql', 'utf8'));
  sqlite.prepare('INSERT INTO subscribers (id,email,status,created_at,magic_token,magic_expires) VALUES (?,?,?,?,?,?)').run('a','a@example.test','active','2026-01-01','token-a','2999-01-01T00:00:00.000Z');
  sqlite.prepare('INSERT INTO subscribers (id,email,status,created_at,magic_token,magic_expires) VALUES (?,?,?,?,?,?)').run('b','b@example.test','active','2026-01-01','token-b','2999-01-01T00:00:00.000Z');
  return { db, sqlite };
}

async function createLink(db, token) {
  const headers = {}; if (token) headers.authorization = 'Bearer ' + token;
  const req = new Request('https://example.test/api/telegram/link', { method: 'POST', headers });
  const res = await linkApi.onRequestPost({ request: req, env: { DB: db }, params: {}, waitUntil() {} });
  return { status: res.status, body: await res.json() };
}

// Intercept tgSend's fetch so tests never contact Telegram; capture message texts.
function captureTelegram() {
  const messages = [];
  const original = globalThis.fetch;
  globalThis.fetch = async (input, init) => {
    const href = String(input);
    if (!href.startsWith('https://api.telegram.org/')) throw new Error('blocked external fetch: ' + href);
    const body = init && typeof init.body === 'string' ? JSON.parse(init.body) : {};
    messages.push(String(body.text || ''));
    return new Response(JSON.stringify({ ok: true }), { status: 200, headers: { 'content-type': 'application/json' } });
  };
  return { messages, restore: () => { globalThis.fetch = original; } };
}

async function webhook(db, text, chatId = 111) {
  const req = new Request('https://example.test/api/telegram', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-telegram-bot-api-secret-token': 'whsec' },
    body: JSON.stringify({ message: { text, chat: { id: chatId } } }),
  });
  const res = await telegram.onRequestPost({ request: req, env: { DB: db, TELEGRAM_BOT_TOKEN: 'test-token', TELEGRAM_WEBHOOK_SECRET: 'whsec' }, params: {}, waitUntil() {} });
  return { status: res.status, body: await res.json() };
}

test('link tokens are short-lived, single-use and never the management token', async () => {
  const { db, sqlite } = await setup();
  try {
    assert.equal((await createLink(db)).status, 401);
    const queryOnly = new Request('https://example.test/api/telegram/link?token=token-a', { method: 'POST' });
    const qres = await linkApi.onRequestPost({ request: queryOnly, env: { DB: db }, params: {}, waitUntil() {} });
    assert.equal(qres.status, 401);

    const created = await createLink(db, 'token-a');
    assert.equal(created.status, 200);
    assert.notEqual(created.body.token, 'token-a');
    const ttl = Date.parse(created.body.expires_at) - Date.now();
    assert.ok(ttl > 5 * 60 * 1000 && ttl <= 16 * 60 * 1000);
    const row = sqlite.prepare('SELECT subscriber_id, used_at FROM telegram_link_tokens WHERE token=?').get(created.body.token);
    assert.equal(row.subscriber_id, 'a');
    assert.equal(row.used_at, null);
    assert.ok(!JSON.stringify(created.body).includes('token-a'));
  } finally { sqlite.close(); }
});

test('a link token links one chat once; reuse, expiry and management tokens are rejected', async () => {
  const { db, sqlite } = await setup();
  const capture = captureTelegram();
  try {
    const first = await createLink(db, 'token-a');
    await webhook(db, '/start ' + first.body.token, 111);
    assert.equal(sqlite.prepare("SELECT telegram_chat_id FROM subscribers WHERE id='a'").get().telegram_chat_id, '111');
    assert.ok(sqlite.prepare('SELECT used_at FROM telegram_link_tokens WHERE token=?').get(first.body.token).used_at);

    // Reuse: a consumed token must not relink another chat.
    await webhook(db, '/start ' + first.body.token, 222);
    assert.equal(sqlite.prepare("SELECT telegram_chat_id FROM subscribers WHERE id='a'").get().telegram_chat_id, '111');
    assert.equal(sqlite.prepare("SELECT count(*) n FROM subscribers WHERE telegram_chat_id='222'").get().n, 0);

    // Expired token.
    const second = await createLink(db, 'token-b');
    sqlite.prepare('UPDATE telegram_link_tokens SET expires_at=? WHERE token=?').run('2000-01-01T00:00:00.000Z', second.body.token);
    await webhook(db, '/start ' + second.body.token, 333);
    assert.equal(sqlite.prepare("SELECT telegram_chat_id FROM subscribers WHERE id='b'").get().telegram_chat_id, null);

    // Management tokens can never link.
    await webhook(db, '/start token-b', 444);
    assert.equal(sqlite.prepare("SELECT count(*) n FROM subscribers WHERE telegram_chat_id='444'").get().n, 0);

    // No Telegram message ever contains a management token.
    assert.ok(capture.messages.length >= 4);
    for (const msg of capture.messages) assert.ok(!msg.includes('token-a') && !msg.includes('token-b'));
  } finally { capture.restore(); sqlite.close(); }
});

test('linking refuses a chat already bound to another subscriber', async () => {
  const { db, sqlite } = await setup();
  const capture = captureTelegram();
  try {
    sqlite.prepare("UPDATE subscribers SET telegram_chat_id='222' WHERE id='b'").run();
    const created = await createLink(db, 'token-a');
    await webhook(db, '/start ' + created.body.token, 222);
    assert.equal(sqlite.prepare("SELECT telegram_chat_id FROM subscribers WHERE id='a'").get().telegram_chat_id, null);
    assert.equal(sqlite.prepare("SELECT telegram_chat_id FROM subscribers WHERE id='b'").get().telegram_chat_id, '222');
    assert.ok(capture.messages.some((m) => m.includes('مرتبط بمشترك آخر')));
  } finally { capture.restore(); sqlite.close(); }
});

test('existing Telegram links and management tokens are untouched', async () => {
  const { db, sqlite } = await setup();
  try {
    sqlite.prepare("UPDATE subscribers SET telegram_chat_id='999' WHERE id='b'").run();
    await createLink(db, 'token-a');
    const b = sqlite.prepare("SELECT telegram_chat_id, magic_token FROM subscribers WHERE id='b'").get();
    assert.equal(b.telegram_chat_id, '999');
    assert.equal(b.magic_token, 'token-b');
    assert.equal(sqlite.prepare('SELECT count(*) n FROM telegram_link_tokens WHERE subscriber_id=?').get('b').n, 0);
  } finally { sqlite.close(); }
});
