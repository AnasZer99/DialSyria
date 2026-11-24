import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import {
  loadEngine,
  loadInterests,
  loadInterestDiscovery,
  loadNotify,
  loadNotifyRoute,
  loadSubscribe,
  loadTelegram,
  loadTelegramLink,
  openDatabase,
} from '../scripts/discovery-runtime.mjs';

// End-to-end workflow against an isolated SQLite database (migrations 0001-0007).
// External services are mocked: Brevo (access email) and Telegram (Bot API).
//
// Brevo dependency documented here: /api/subscribe and /api/login return 503 unless
// BREVO_API_KEY and SENDER_EMAIL are configured, so self-serve onboarding requires a
// mail provider. The rest of the workflow (interests, linking, discovery, delivery,
// details) does not depend on Brevo.
const subscribe = await loadSubscribe();
const api = await loadInterests();
const engine = await loadEngine();
const discover = await loadInterestDiscovery();
const linkApi = await loadTelegramLink();
const telegram = await loadTelegram();
const notify = await loadNotify();
const notifyRoute = await loadNotifyRoute();

function stubExternal() {
  const emails = [];
  const telegramMessages = [];
  const original = globalThis.fetch;
  globalThis.fetch = async (input, init) => {
    const href = String(input);
    if (href.startsWith('https://api.brevo.com/')) {
      emails.push(JSON.parse(String((init && init.body) || '{}')));
      return new Response(JSON.stringify({ messageId: 'test' }), { status: 201 });
    }
    if (href.startsWith('https://api.telegram.org/')) {
      const body = init && typeof init.body === 'string' ? JSON.parse(init.body) : {};
      telegramMessages.push({ chatId: body.chat_id, text: String(body.text || '') });
      return new Response(JSON.stringify({ ok: true }), { status: 200 });
    }
    throw new Error('blocked external fetch: ' + href);
  };
  return { emails, telegramMessages, restore: () => { globalThis.fetch = original; } };
}

function jsonRequest(path, body, headers = {}, method = 'POST') {
  return new Request('https://dial.test' + path, {
    method,
    headers: { 'content-type': 'application/json', ...headers },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
}

async function call(handler, db, request, env = {}) {
  const res = await handler({ request, env: { DB: db, ...env }, params: {}, waitUntil() {} });
  return { status: res.status, body: await res.json().catch(() => ({})) };
}

test('complete user-to-notification workflow on an isolated database', async () => {
  const { db, sqlite } = await openDatabase(':memory:');
  sqlite.exec(await readFile('schema.sql', 'utf8'));
  const ext = stubExternal();
  try {
    // 1. Registration through the real endpoint (Brevo mocked; response exposes no token).
    const reg = await call(
      subscribe.onRequestPost,
      db,
      jsonRequest('/api/subscribe', { email: 'user@example.test', topics: ['politics'], delivery_hour: 7, language: 'ar' }),
      { BREVO_API_KEY: 'test-key', SENDER_EMAIL: 'sender@example.test' }
    );
    assert.equal(reg.status, 200);
    assert.deepEqual(Object.keys(reg.body), ['ok']);
    assert.equal(ext.emails.length, 1);
    const tokenMatch = String(ext.emails[0].htmlContent || '').match(/\/manage\?token=([0-9a-f-]{36})/);
    assert.ok(tokenMatch);
    const manageToken = tokenMatch[1];
    const sub = sqlite.prepare('SELECT id, status FROM subscribers WHERE email=?').get('user@example.test');
    assert.equal(sub.status, 'trial');

    // 2. Authenticated interest management (Bearer management token).
    const auth = { authorization: 'Bearer ' + manageToken };
    const empty = await call(api.onRequestGet, db, jsonRequest('/api/interests', undefined, auth, 'GET'));
    assert.deepEqual(empty.body.interests, []);
    const created = await call(api.onRequestPost, db, jsonRequest('/api/interests', { text: 'قرارات البناء والتراخيص في إدلب' }, auth));
    assert.equal(created.status, 201);
    const interestId = created.body.interest.id;
    assert.equal((await call(api.onRequestPost, db, jsonRequest('/api/interests', { text: 'قرارات البناء والتراخيص في ادلب' }, auth))).status, 409);
    assert.equal((await call(api.onRequestGet, db, jsonRequest('/api/interests', undefined, auth, 'GET'))).body.interests.length, 1);

    // 3. Telegram link token creation and single use.
    const link = await call(linkApi.onRequestPost, db, jsonRequest('/api/telegram/link', undefined, auth));
    assert.equal(link.status, 200);
    assert.ok(!JSON.stringify(link.body).includes(manageToken));
    const webhookHeaders = { 'x-telegram-bot-api-secret-token': 'whsec' };
    const webhookEnv = { TELEGRAM_BOT_TOKEN: 'bot-token', TELEGRAM_WEBHOOK_SECRET: 'whsec' };
    await call(telegram.onRequestPost, db, jsonRequest('/api/telegram', { message: { text: '/start ' + link.body.token, chat: { id: 7001 } } }, webhookHeaders), webhookEnv);
    assert.equal(sqlite.prepare('SELECT telegram_chat_id FROM subscribers WHERE id=?').get(sub.id).telegram_chat_id, '7001');
    assert.ok(!ext.telegramMessages.some((m) => m.text.includes(manageToken)));

    // 4. Interest-based discovery with the deterministic mock provider.
    const found = await call(discover.onRequestPost, db, jsonRequest('/api/interests/discover', { id: interestId }, auth), { ALLOW_MOCK_DISCOVERY: '1' });
    assert.equal(found.status, 200);
    assert.equal(found.body.report.mock, true);
    assert.ok(sqlite.prepare('SELECT count(*) n FROM discovery_items WHERE is_mock=1').get().n >= 1);

    // 5. Mock discovery results are never delivered as genuine news.
    const beforeLive = await notify.prepareNotifications(db, sub.id);
    assert.equal(beforeLive.items.length, 0);
    assert.equal(sqlite.prepare('SELECT count(*) n FROM notifications WHERE subscriber_id=?').get(sub.id).n, 0);

    // 6. Deterministic verified data, as a live discovery run would store it.
    const key = engine.normalize('قرارات البناء والتراخيص في إدلب');
    const addLive = (id, title, description, source, publishedAt, url, verification, originalUrl) => {
      sqlite.prepare('INSERT INTO discovery_items (id,url,title_key,title,description,source,published_at,discovered_at,source_host,is_mock,publisher_published_at,original_url,verification_status) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)')
        .run(id, url, 'key-' + id, title, description, source, publishedAt, '2026-11-21T00:00:00.000Z', 'news.example.org', 0, publishedAt, originalUrl, verification);
      sqlite.prepare('INSERT INTO discovery_item_interests (interest_key,item_id,score) VALUES (?,?,?)').run(key, id, 0.9);
    };
    addLive('e2e-live-1', 'قرار جديد لتراخيص البناء في إدلب', 'أصدرت الجهات المختصة قراراً يحدد ضوابط تراخيص البناء في محافظة إدلب.', 'سانا', '2026-11-20T09:00:00.000Z', 'https://news.example.org/e2e-idlib', 'publisher_metadata; title_match', 'https://news.example.org/e2e-idlib');
    addLive('e2e-unverified', 'خبر غير موثّق عن البناء في إدلب', 'نص غير موثّق.', 'مصدر غير موثّق', '2026-11-20T07:00:00.000Z', 'https://news.example.org/e2e-unverified', 'not_attempted', null);
    sqlite.prepare('INSERT INTO direct_sources (id,url,kind,name,discovered_at) VALUES (?,?,?,?,?)').run('e2e-src', 'https://direct.example.org', 'website', 'موقع مباشر', '2026-11-01T00:00:00.000Z');
    sqlite.prepare('INSERT INTO direct_source_interests (interest_key,source_id) VALUES (?,?)').run(key, 'e2e-src');
    const directItem = (id, url, title, content, publishedAt) =>
      sqlite.prepare('INSERT INTO direct_items (id,source_id,url,title,content,published_at,first_seen) VALUES (?,?,?,?,?,?,?)')
        .run(id, 'e2e-src', url, title, content, publishedAt, '2026-11-21T00:00:00.000Z');
    directItem('e2e-dir-rel', 'https://direct.example.org/idlib', 'قرار تنظيم البناء في إدلب', 'اجتماع لمناقشة تنظيم البناء في محافظة إدلب', '2026-11-20T08:00:00.000Z');
    directItem('e2e-dir-irr', 'https://direct.example.org/sport', 'مباراة كرة القدم في حلب', 'نتيجة المباراة', '2026-11-20T06:00:00.000Z');

    // 7. Relevance filtering and preparation.
    const prepared = await notify.prepareNotifications(db, sub.id);
    assert.equal(prepared.items.length, 2);
    assert.ok(prepared.items.some((x) => x.kind === 'discovery' && x.title.includes('قرار جديد')));
    assert.ok(prepared.items.some((x) => x.kind === 'direct' && x.title.includes('قرار تنظيم')));
    for (const forbidden of ['غير موثّق', 'مباراة', 'mock-source.test']) assert.ok(!prepared.text.includes(forbidden));
    assert.match(prepared.text, /https:\/\/news\.example\.org\/e2e-idlib/);

    // 8. Simulated delivery is non-persistent: it renders the message but never marks
    //    rows delivered and never reaches Telegram.
    const cron = { 'x-cron-secret': 'cron-secret' };
    const sim = await call(notifyRoute.onRequestPost, db, jsonRequest('/api/notify', { subscriber_id: sub.id, simulate: true }, cron), { CRON_SECRET: 'cron-secret' });
    assert.equal(sim.status, 200);
    assert.equal(sim.body.simulated, true);
    assert.equal(sim.body.sent, 0);
    assert.equal(sim.body.messages.length, 1);
    assert.match(sim.body.messages[0], /https:\/\/news\.example\.org\/e2e-idlib/);
    for (const row of sqlite.prepare('SELECT status, sent_at FROM notifications WHERE subscriber_id=?').all(sub.id)) {
      assert.equal(row.status, 'prepared');
      assert.equal(row.sent_at, null);
    }
    assert.ok(!ext.telegramMessages.some((m) => m.text.includes('قرار جديد لتراخيص البناء')));

    // Real delivery (mock transport) records sent only after transport success.
    const delivered = await notify.runPreparation(db, { subscriberId: sub.id, transport: notify.createMockTelegramTransport() });
    assert.ok(delivered.sent >= 2);
    for (const row of sqlite.prepare('SELECT status, sent_at FROM notifications WHERE subscriber_id=?').all(sub.id)) {
      assert.equal(row.status, 'sent');
      assert.ok(row.sent_at);
    }

    // 9. Notification details through the Telegram /more interaction.
    const target = sqlite.prepare("SELECT id FROM notifications WHERE subscriber_id=? AND url='https://news.example.org/e2e-idlib'").get(sub.id);
    assert.ok(target);
    await call(telegram.onRequestPost, db, jsonRequest('/api/telegram', { message: { text: '/more ' + target.id, chat: { id: 7001 } } }, webhookHeaders), webhookEnv);
    const details = ext.telegramMessages.at(-1);
    assert.ok(details);
    assert.match(details.text, /قرار جديد لتراخيص البناء في إدلب/);
    assert.match(details.text, /سانا/);
    assert.match(details.text, /2026-11-20/);
    assert.match(details.text, /https:\/\/news\.example\.org\/e2e-idlib/);

    // 10. Duplicate prevention across repeated runs.
    const again = await notify.runPreparation(db, { subscriberId: sub.id, transport: notify.createMockTelegramTransport() });
    assert.equal(again.sent, 0);
    assert.equal(sqlite.prepare('SELECT count(*) n FROM notifications WHERE subscriber_id=?').get(sub.id).n, 2);

    // 11. Failure handling and safe retry.
    addLive('e2e-live-2', 'قرار ثانٍ لتراخيص البناء في إدلب', 'تفاصيل إضافية عن تراخيص البناء في إدلب.', 'سانا', '2026-11-21T09:00:00.000Z', 'https://news.example.org/e2e-idlib-2', 'publisher_metadata; title_match', 'https://news.example.org/e2e-idlib-2');
    const failedRun = await notify.runPreparation(db, { subscriberId: sub.id, transport: notify.createMockTelegramTransport({ failError: 'mock outage' }) });
    assert.ok(failedRun.failed >= 1);
    const failedRow = sqlite.prepare("SELECT status, sent_at, error FROM notifications WHERE subscriber_id=? AND item_id='e2e-live-2'").get(sub.id);
    assert.equal(failedRow.status, 'failed');
    assert.equal(failedRow.sent_at, null);
    assert.equal(failedRow.error, 'mock outage');
    const retried = await notify.runPreparation(db, { subscriberId: sub.id, transport: notify.createMockTelegramTransport() });
    assert.ok(retried.sent >= 1);
    assert.equal(sqlite.prepare("SELECT status FROM notifications WHERE subscriber_id=? AND item_id='e2e-live-2'").get(sub.id).status, 'sent');
  } finally {
    ext.restore();
    sqlite.close();
  }
});
