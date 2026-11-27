import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { loadEngine, loadInterests, loadNotify, loadNotifyRoute, openDatabase } from '../scripts/discovery-runtime.mjs';

const api = await loadInterests();
const engine = await loadEngine();
const notify = await loadNotify();
const route = await loadNotifyRoute();

const IDLIB = 'قرارات البناء والتراخيص في إدلب';
const ALEPPO = 'أخبار الكهرباء في حلب';

async function setup() {
  const { db, sqlite } = await openDatabase(':memory:');
  sqlite.exec(await readFile('schema.sql', 'utf8'));
  for (const id of ['a', 'b']) {
    sqlite.prepare('INSERT INTO subscribers (id,email,status,created_at) VALUES (?,?,?,?)').run(id, id + '@example.test', 'active', '2026-01-01');
  }
  sqlite.prepare("UPDATE subscribers SET telegram_chat_id='111' WHERE id='a'").run();
  const interest = (sub, text) =>
    sqlite.prepare('INSERT INTO subscriber_interests (id,subscriber_id,text,normalized_text,created_at,updated_at) VALUES (?,?,?,?,?,?)')
      .run('int-' + sub, sub, text, api.normalizeInterest(text), '2026-01-01', '2026-01-01');
  interest('a', IDLIB);
  interest('b', ALEPPO);
  const item = (id, title, text, key) => {
    sqlite.prepare('INSERT INTO discovery_items (id,url,title_key,title,description,source,published_at,discovered_at,source_host,is_mock,publisher_published_at,original_url,verification_status) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)')
      .run(id, 'https://news.example.org/' + id, 'key-' + id, title, 'نص الخبر الموثّق.', 'سانا', '2026-11-20T09:00:00.000Z', '2026-11-21T00:00:00.000Z', 'news.example.org', 0, '2026-11-20T09:00:00.000Z', 'https://news.example.org/' + id, 'publisher_metadata; title_match');
    sqlite.prepare('INSERT INTO discovery_item_interests (interest_key,item_id,score) VALUES (?,?,?)').run(key, id, 0.9);
  };
  item('sched-a', 'قرار جديد لتراخيص البناء في إدلب', IDLIB, engine.normalize(IDLIB));
  item('sched-b', 'تحسن واقع الكهرباء في حلب', ALEPPO, engine.normalize(ALEPPO));
  return { db, sqlite };
}

function stubTelegram(opts = {}) {
  const calls = [];
  const original = globalThis.fetch;
  globalThis.fetch = async (input, init) => {
    const href = String(input);
    if (!href.startsWith('https://api.telegram.org/')) throw new Error('blocked external fetch: ' + href);
    const body = init && typeof init.body === 'string' ? JSON.parse(init.body) : {};
    calls.push({ url: href, chatId: body.chat_id, text: String(body.text || '') });
    if (opts.fail) return new Response(JSON.stringify({ ok: false }), { status: 500 });
    return new Response(JSON.stringify({ ok: true }), { status: 200 });
  };
  return { calls, restore: () => { globalThis.fetch = original; } };
}

async function runRoute(db, body, env = {}) {
  const req = new Request('https://dial.test/api/notify', { method: 'POST', headers: { 'content-type': 'application/json', 'x-cron-secret': 'cron-secret' }, body: JSON.stringify(body ?? {}) });
  const res = await route.onRequestPost({ request: req, env: { DB: db, CRON_SECRET: 'cron-secret', ...env }, params: {}, waitUntil() {} });
  return { status: res.status, body: await res.json() };
}

test('delivery is disabled by default: scheduled runs prepare but never contact Telegram', async () => {
  const { db, sqlite } = await setup();
  const stub = stubTelegram();
  try {
    const res = await runRoute(db, { mode: 'deliver' });
    assert.equal(res.status, 200);
    assert.equal(res.body.deliveryEnabled, false);
    assert.equal(res.body.dryRun, true);
    assert.equal(res.body.sent, 0);
    assert.equal(stub.calls.length, 0);
    assert.equal(sqlite.prepare("SELECT count(*) n FROM notifications WHERE status='prepared'").get().n, 2);
  } finally { stub.restore(); sqlite.close(); }
});

test('enabled delivery uses the Bot API adapter; subscribers without a chat stay prepared', async () => {
  const { db, sqlite } = await setup();
  const stub = stubTelegram();
  try {
    const res = await runRoute(db, { mode: 'deliver' }, { TELEGRAM_DELIVERY_ENABLED: '1', TELEGRAM_BOT_TOKEN: 'bot-token', TELEGRAM_TEST_CHAT_IDS: '111' });
    assert.equal(res.status, 200);
    assert.equal(res.body.deliveryEnabled, true);
    assert.equal(res.body.dryRun, false);
    assert.equal(res.body.sent, 1);
    assert.equal(stub.calls.length, 1);
    assert.ok(stub.calls[0].url.startsWith('https://api.telegram.org/botbot-token/sendMessage'));
    assert.equal(String(stub.calls[0].chatId), '111');
    assert.match(stub.calls[0].text, /https:\/\/news\.example\.org\/sched-a/);
    const a = sqlite.prepare("SELECT status, sent_at FROM notifications WHERE subscriber_id='a'").get();
    assert.equal(a.status, 'sent');
    assert.ok(a.sent_at);
    const b = sqlite.prepare("SELECT status, sent_at FROM notifications WHERE subscriber_id='b'").get();
    assert.equal(b.status, 'prepared');
    assert.equal(b.sent_at, null);
  } finally { stub.restore(); sqlite.close(); }
});

test('failed transport is recorded and retries do not duplicate', async () => {
  const { db, sqlite } = await setup();
  const failing = stubTelegram({ fail: true });
  try {
    const res = await runRoute(db, { mode: 'deliver' }, { TELEGRAM_DELIVERY_ENABLED: '1', TELEGRAM_BOT_TOKEN: 'bot-token', TELEGRAM_TEST_CHAT_IDS: '111' });
    assert.equal(res.body.sent, 0);
    assert.ok(res.body.failed >= 1);
    const failed = sqlite.prepare("SELECT status, sent_at, error FROM notifications WHERE subscriber_id='a'").get();
    assert.equal(failed.status, 'failed');
    assert.equal(failed.sent_at, null);
    assert.ok(failed.error);
  } finally { failing.restore(); }
  const ok = stubTelegram();
  try {
    const retried = await runRoute(db, { mode: 'deliver' }, { TELEGRAM_DELIVERY_ENABLED: '1', TELEGRAM_BOT_TOKEN: 'bot-token', TELEGRAM_TEST_CHAT_IDS: '111' });
    assert.ok(retried.body.sent >= 1);
    const again = await runRoute(db, { mode: 'deliver' }, { TELEGRAM_DELIVERY_ENABLED: '1', TELEGRAM_BOT_TOKEN: 'bot-token', TELEGRAM_TEST_CHAT_IDS: '111' });
    assert.equal(again.body.sent, 0);
    assert.equal(ok.calls.length, 1);
    assert.equal(sqlite.prepare("SELECT status FROM notifications WHERE subscriber_id='a'").get().status, 'sent');
  } finally { ok.restore(); sqlite.close(); }
});

test('overlapping scheduled runs cannot double-send; stale claims recover', async () => {
  const { db, sqlite } = await setup();
  try {
    await notify.prepareNotifications(db, 'a');
    // Another run holds the lease on both rows.
    sqlite.prepare("UPDATE notifications SET status='sending', claimed_at=? WHERE subscriber_id='a'").run(new Date().toISOString());
    const mock = notify.createMockTelegramTransport();
    const inFlight = await notify.deliverPending(db, 'a', mock);
    assert.equal(inFlight.sent, 0);
    assert.equal(mock.messages.length, 0);
    // A lease older than the 10-minute window is reclaimable.
    sqlite.prepare("UPDATE notifications SET claimed_at=? WHERE subscriber_id='a'").run('2000-01-01T00:00:00.000Z');
    const recovered = await notify.deliverPending(db, 'a', mock);
    assert.ok(recovered.sent >= 1);
    assert.equal(mock.messages.length, 1);
    assert.equal(sqlite.prepare("SELECT count(*) n FROM notifications WHERE subscriber_id='a' AND status='sent'").get().n, recovered.sent);
  } finally { sqlite.close(); }
});

test('the RSS cron schedules ingestion and digests only', async () => {
  const cron = (await import('../cron-worker/index.js')).default;
  const calls = [];
  const original = globalThis.fetch;
  globalThis.fetch = async (input, init) => {
    calls.push({ url: String(input), method: (init && init.method) || 'GET', headers: (init && init.headers) || {}, body: init && init.body ? JSON.parse(String(init.body)) : undefined });
    return new Response('{}', { status: 200 });
  };
  try {
    const pending = [];
    await cron.scheduled({ cron: '7 * * * *' }, { SITE_URL: 'https://dial.test', CRON_SECRET: 's3cret' }, { waitUntil: (p) => pending.push(p) });
    await Promise.all(pending);
    assert.deepEqual(calls.map((c) => c.url), ['https://dial.test/api/digest']);
    assert.equal(calls[0].method, 'POST');
    assert.equal(calls[0].headers['x-cron-secret'], 's3cret');
    assert.ok(!calls.some((c) => c.url.endsWith('/api/notify')));
    assert.ok(!calls.some((c) => c.url.endsWith('/api/direct')));

    calls.length = 0;
    const pending2 = [];
    await cron.scheduled({ cron: '0 1 * * *' }, { SITE_URL: 'https://dial.test', CRON_SECRET: 's3cret' }, { waitUntil: (p) => pending2.push(p) });
    await Promise.all(pending2);
    assert.deepEqual(calls.map((c) => c.url), ['https://dial.test/api/ingest']);
    assert.equal(calls[0].method, 'POST');
    assert.equal(calls[0].headers['x-cron-secret'], 's3cret');
    assert.ok(!calls.some((c) => c.url.endsWith('/api/notify')));
    assert.ok(!calls.some((c) => c.url.endsWith('/api/direct')));

    calls.length = 0;
    const pending3 = [];
    await cron.scheduled({ cron: '*/30 * * * *' }, { SITE_URL: 'https://dial.test', CRON_SECRET: 's3cret' }, { waitUntil: (p) => pending3.push(p) });
    await Promise.all(pending3);
    assert.equal(calls.length, 0); // retired schedule: no calls
  } finally { globalThis.fetch = original; }
});

test('the RSS cron worker source contains no Telegram or Beta routes', async () => {
  const source = await readFile(new URL('../cron-worker/index.js', import.meta.url), 'utf8');
  assert.ok(source.includes('/api/ingest'));
  assert.ok(source.includes('/api/digest'));
  assert.ok(!source.includes('/api/notify'));
  assert.ok(!source.includes('/api/direct'));
});

test('scheduler transport errors are caught and reported without leaking secrets', async () => {
  const cron = (await import('../cron-worker/index.js')).default;
  const logs = [];
  const originalError = console.error;
  console.error = (...args) => logs.push(args.map(String).join(' '));
  const original = globalThis.fetch;
  globalThis.fetch = async (input) => {
    if (String(input).endsWith('/api/digest')) throw new Error('boom');
    return new Response('{}', { status: 200 });
  };
  try {
    const pending = [];
    await cron.scheduled({ cron: '7 * * * *' }, { SITE_URL: 'https://dial.test', CRON_SECRET: 's3cret' }, { waitUntil: (p) => pending.push(p) });
    await Promise.all(pending); // resolves because the digest rejection is caught
    assert.ok(logs.some((l) => l.includes('network error') && l.includes('/api/digest')));
    assert.ok(!logs.some((l) => l.includes('s3cret')));
  } finally {
    console.error = originalError;
    globalThis.fetch = original;
  }
});

test('scheduled calls log non-success HTTP statuses without exposing secrets', async () => {
  const cron = (await import('../cron-worker/index.js')).default;
  const logs = [];
  const originalError = console.error;
  console.error = (...args) => logs.push(args.map(String).join(' '));
  const originalFetch = globalThis.fetch;
  try {
    globalThis.fetch = async (input) => {
      const href = String(input);
      if (href.endsWith('/api/ingest')) return new Response('{}', { status: 401 });
      if (href.endsWith('/api/digest')) return new Response('{}', { status: 500 });
      return new Response('{}', { status: 200 });
    };
    const pending = [];
    await cron.scheduled({ cron: '0 1 * * *' }, { SITE_URL: 'https://dial.test', CRON_SECRET: 's3cret' }, { waitUntil: (p) => pending.push(p) });
    await Promise.all(pending);
    assert.ok(logs.some((l) => l.includes('401') && l.includes('/api/ingest')));
    assert.ok(!logs.some((l) => l.includes('/api/direct'))); // isolated: never called by the MVP cron
    assert.ok(!logs.some((l) => l.includes('/api/notify'))); // Telegram route is not scheduled

    logs.length = 0;
    const pending2 = [];
    await cron.scheduled({ cron: '7 * * * *' }, { SITE_URL: 'https://dial.test', CRON_SECRET: 's3cret' }, { waitUntil: (p) => pending2.push(p) });
    await Promise.all(pending2);
    assert.ok(logs.some((l) => l.includes('500') && l.includes('/api/digest')));
    assert.ok(!logs.some((l) => l.includes('/api/notify'))); // never scheduled by the RSS cron
    assert.ok(!logs.some((l) => l.includes('s3cret'))); // secret never logged
  } finally {
    console.error = originalError;
    globalThis.fetch = originalFetch;
  }
});

test('test-recipient allowlist restricts real delivery to configured chat IDs', async () => {
  const { db, sqlite } = await setup();
  sqlite.prepare("UPDATE subscribers SET telegram_chat_id='222' WHERE id='b'").run();
  const stub = stubTelegram();
  try {
    const res = await runRoute(db, { mode: 'deliver' }, { TELEGRAM_DELIVERY_ENABLED: '1', TELEGRAM_BOT_TOKEN: 'bot-token', TELEGRAM_TEST_CHAT_IDS: '111' });
    assert.equal(res.status, 200);
    assert.equal(res.body.deliveryEnabled, true);
    assert.equal(res.body.testRecipientCount, 1);
    assert.equal(stub.calls.length, 1);
    assert.equal(String(stub.calls[0].chatId), '111');
    assert.equal(sqlite.prepare("SELECT status FROM notifications WHERE subscriber_id='a'").get().status, 'sent');
    assert.equal(sqlite.prepare("SELECT status FROM notifications WHERE subscriber_id='b'").get().status, 'prepared');
  } finally { stub.restore(); sqlite.close(); }
});

test('delivery enabled without an allowlist denies every recipient', async () => {
  const { db, sqlite } = await setup();
  sqlite.prepare("UPDATE subscribers SET telegram_chat_id='222' WHERE id='b'").run();
  const stub = stubTelegram();
  try {
    const res = await runRoute(db, { mode: 'deliver' }, { TELEGRAM_DELIVERY_ENABLED: '1', TELEGRAM_BOT_TOKEN: 'bot-token' });
    assert.equal(res.body.deliveryEnabled, true);
    assert.equal(res.body.testRecipientCount, 0);
    assert.equal(stub.calls.length, 0);
    assert.equal(sqlite.prepare("SELECT count(*) n FROM notifications WHERE status='sent'").get().n, 0);
    assert.equal(sqlite.prepare("SELECT count(*) n FROM notifications WHERE status='prepared'").get().n, 2);
  } finally { stub.restore(); sqlite.close(); }
});
