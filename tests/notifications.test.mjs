import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { loadEngine, loadInterests, loadNotify, loadNotifyRoute, openDatabase } from '../scripts/discovery-runtime.mjs';

const api = await loadInterests();
const engine = await loadEngine();
const notify = await loadNotify();
const notifyRoute = await loadNotifyRoute();

const texts = {
  idlib: 'قرارات البناء والتراخيص في إدلب',
  aleppo: 'أخبار الكهرباء في حلب',
  mockOnly: 'تحديثات البناء التجريبية في إدلب',
  nodate: 'مشروع تطوير الحدائق في حمص',
};
const keys = Object.fromEntries(Object.entries(texts).map(([name, text]) => [name, engine.normalize(text)]));

async function setup() {
  const { db, sqlite } = await openDatabase(':memory:');
  sqlite.exec(await readFile('schema.sql', 'utf8'));
  for (const id of ['a', 'b', 'c', 'd']) {
    sqlite.prepare('INSERT INTO subscribers (id,email,status,created_at) VALUES (?,?,?,?)').run(id, id + '@example.test', 'active', '2026-01-01');
  }
  const interest = (sub, text) =>
    sqlite.prepare('INSERT INTO subscriber_interests (id,subscriber_id,text,normalized_text,created_at,updated_at) VALUES (?,?,?,?,?,?)')
      .run('int-' + sub, sub, text, api.normalizeInterest(text), '2026-01-01', '2026-01-01');
  interest('a', texts.idlib);
  interest('b', texts.aleppo);
  interest('c', texts.mockOnly);
  interest('d', texts.nodate);

  const item = (id, title, description, source, publishedAt, isMock, url, verification = 'publisher_metadata; title_match', originalUrl = url) =>
    sqlite.prepare('INSERT INTO discovery_items (id,url,title_key,title,description,source,published_at,discovered_at,source_host,is_mock,publisher_published_at,original_url,verification_status) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)')
      .run(id, url, 'key-' + id, title, description, source, publishedAt, '2026-11-21T00:00:00.000Z', 'news.example.org', isMock, publishedAt, originalUrl, verification);
  const link = (key, id) =>
    sqlite.prepare('INSERT INTO discovery_item_interests (interest_key,item_id,score) VALUES (?,?,?)').run(key, id, 0.9);

  item('idlib', 'قرار جديد لتراخيص البناء في إدلب', 'أصدرت الجهات المختصة قراراً يحدد ضوابط تراخيص البناء في محافظة إدلب مع مهلة لتسوية المخالفات القائمة.', 'سانا', '2026-11-20T09:00:00.000Z', 0, 'https://news.example.org/idlib');
  item('aleppo', 'تحسن واقع الكهرباء في حلب', 'شهدت أحياء حلب تحسناً في ساعات التغذية الكهربائية خلال الأسبوع الجاري.', 'عنب بلدي', '2026-11-19T12:00:00.000Z', 0, 'https://news.example.org/aleppo');
  item('unverified', 'خبر غير موثّق عن تراخيص البناء في إدلب', 'نص غير موثّق.', 'مصدر غير موثّق', '2026-11-20T07:00:00.000Z', 0, 'https://news.example.org/unverified', 'not_attempted', null);
  item('mock', 'خبر تجريبي عن البناء في إدلب', 'نص تجريبي ثابت.', 'مصدر تجريبي', null, 1, 'https://mock-source.test/news/idlib-building-licence');
  item('nodate', 'تطوير حدائق حمص', 'مشروع لتطوير الحدائق العامة.', 'حمص اليوم', null, 0, 'https://news.example.org/homs');

  link(keys.idlib, 'idlib');
  link(keys.idlib, 'unverified');
  link(keys.idlib, 'mock');
  link(keys.mockOnly, 'mock');
  link(keys.aleppo, 'aleppo');
  link(keys.nodate, 'nodate');

  sqlite.prepare('INSERT INTO direct_sources (id,url,kind,name,discovered_at) VALUES (?,?,?,?,?)').run('src1', 'https://direct.example.org', 'website', 'موقع مباشر', '2026-11-01T00:00:00.000Z');
  sqlite.prepare('INSERT INTO direct_source_interests (interest_key,source_id) VALUES (?,?)').run(keys.idlib, 'src1');
  const directItem = (id, url, title, content, publishedAt) =>
    sqlite.prepare('INSERT INTO direct_items (id,source_id,url,title,content,published_at,first_seen,verification_status) VALUES (?,?,?,?,?,?,?,?)')
      .run(id, 'src1', url, title, content, publishedAt, '2026-11-21T00:00:00.000Z', 'publisher_title_match');
  directItem('dir1', 'https://direct.example.org/idlib', 'قرار تنظيم البناء في إدلب', 'اجتماع لمناقشة تنظيم البناء في محافظة إدلب', '2026-11-20T08:00:00.000Z');
  directItem('dir2', 'https://direct.example.org/sport', 'مباراة كرة القدم في حلب', 'انتهت المباراة بفوز الفريق المضيف', '2026-11-20T06:00:00.000Z');
  directItem('dir-test', 'https://mock-source.test/direct-item', 'قرار تنظيم البناء في إدلب', 'نص اختباري', '2026-11-20T05:00:00.000Z');
  // Same article URL as the discovery item: must collapse to one notification.
  directItem('dup1', 'https://news.example.org/idlib', 'قرار جديد لتراخيص البناء في إدلب', 'تغطية مباشرة للقرار', '2026-11-19T23:00:00.000Z');

  return { db, sqlite };
}

test('preparation delivers verified live discovery items and relevant direct items only', async () => {
  const { db, sqlite } = await setup();
  try {
    const result = await notify.prepareNotifications(db, 'a');
    assert.equal(result.items.length, 2);
    assert.deepEqual(result.items.map((x) => x.kind).sort(), ['direct', 'discovery']);
    assert.ok(result.items.some((x) => x.title === 'قرار جديد لتراخيص البناء في إدلب'));
    assert.ok(result.items.some((x) => x.title === 'قرار تنظيم البناء في إدلب'));
    assert.match(result.text, /سانا/);
    assert.match(result.text, /2026-11-20/);
    assert.match(result.text, /https:\/\/news\.example\.org\/idlib/);
    assert.match(result.text, /https:\/\/direct\.example\.org\/idlib/);
    // Unverified, mock, test-domain and irrelevant-source posts never appear.
    assert.ok(!result.text.includes('غير موثّق'));
    assert.ok(!result.text.includes('تجريبي'));
    assert.ok(!result.text.includes('مباراة'));
    assert.ok(!result.text.includes('mock-source.test'));
    // Cross-store duplicate collapses to a single notification row for that URL.
    assert.equal(sqlite.prepare("SELECT count(*) n FROM notifications WHERE url='https://news.example.org/idlib'").get().n, 1);

    const rows = sqlite.prepare("SELECT status, sent_at, source, url, published_at, excerpt FROM notifications WHERE subscriber_id='a' ORDER BY url").all();
    assert.equal(rows.length, 2);
    for (const row of rows) {
      assert.equal(row.status, 'prepared');
      assert.equal(row.sent_at, null);
      assert.ok(row.excerpt && row.excerpt.length > 10);
      assert.ok(row.source);
      assert.match(row.url, /^https:\/\//);
    }
    assert.ok(rows.some((r) => r.published_at === '2026-11-20T09:00:00.000Z'));
  } finally { sqlite.close(); }
});

test('different subscribers receive different previews; mock-only and dateless cases are safe', async () => {
  const { db, sqlite } = await setup();
  try {
    const a = await notify.prepareNotifications(db, 'a');
    const b = await notify.prepareNotifications(db, 'b');
    assert.equal(b.items.length, 1);
    assert.equal(b.items[0].title, 'تحسن واقع الكهرباء في حلب');
    assert.ok(!b.text.includes('تراخيص البناء'));
    assert.notEqual(a.text, b.text);

    const c = await notify.prepareNotifications(db, 'c');
    assert.equal(c.items.length, 0);
    assert.equal(c.text, '');
    assert.equal(sqlite.prepare("SELECT count(*) n FROM notifications WHERE subscriber_id='c'").get().n, 0);

    const d = await notify.prepareNotifications(db, 'd');
    assert.equal(d.items.length, 1);
    assert.match(d.text, /حمص اليوم/);
    assert.ok(!/\d{4}-\d{2}-\d{2}/.test(d.text));
  } finally { sqlite.close(); }
});

test('dry-run preparation performs no messaging and never repeats rows', async () => {
  const { db, sqlite } = await setup();
  try {
    const run = await notify.runPreparation(db);
    assert.equal(run.dryRun, true);
    assert.equal(run.messages.length, 0);
    assert.ok(run.prepared >= 3);
    assert.equal(run.sent, 0);
    const preparedRows = sqlite.prepare("SELECT count(*) n FROM notifications WHERE status='prepared'").get().n;
    assert.ok(preparedRows >= 3);
    assert.equal(sqlite.prepare("SELECT count(*) n FROM notifications WHERE sent_at IS NOT NULL").get().n, 0);

    const again = await notify.runPreparation(db);
    assert.equal(again.prepared, 0);
    assert.equal(sqlite.prepare('SELECT count(*) n FROM notifications').get().n, preparedRows);
  } finally { sqlite.close(); }
});

test('delivery only marks sent after success; failures stay retryable without duplicates', async () => {
  const { db, sqlite } = await setup();
  try {
    const failing = {
      calls: [],
      async send(text) { this.calls.push(text); return { ok: false, error: 'gateway down' }; },
    };
    const failedRun = await notify.runPreparation(db, { transport: failing, subscriberId: 'a' });
    assert.equal(failedRun.dryRun, false);
    assert.ok(failedRun.failed >= 1);
    assert.equal(failing.calls.length, 1);
    const failedRows = sqlite.prepare("SELECT status, sent_at, error FROM notifications WHERE subscriber_id='a'").all();
    assert.ok(failedRows.length >= 1);
    for (const row of failedRows) {
      assert.equal(row.status, 'failed');
      assert.equal(row.sent_at, null);
      assert.equal(row.error, 'gateway down');
    }

    const okTransport = {
      calls: [],
      async send(text) { this.calls.push(text); return { ok: true }; },
    };
    const retried = await notify.runPreparation(db, { transport: okTransport, subscriberId: 'a' });
    assert.ok(retried.sent >= 1);
    assert.equal(okTransport.calls.length, 1);
    assert.match(okTransport.calls[0], /https:\/\//);
    const sentRows = sqlite.prepare("SELECT status, sent_at, error FROM notifications WHERE subscriber_id='a'").all();
    for (const row of sentRows) {
      assert.equal(row.status, 'sent');
      assert.ok(row.sent_at);
      assert.equal(row.error, null);
    }

    const noDup = await notify.runPreparation(db, { transport: okTransport, subscriberId: 'a' });
    assert.equal(noDup.sent, 0);
    assert.equal(okTransport.calls.length, 1);
    assert.equal(sqlite.prepare("SELECT count(*) n FROM notifications WHERE subscriber_id='a'").get().n, sentRows.length);
  } finally { sqlite.close(); }
});

test('notification preparation cannot send messages externally', async () => {
  const source = await readFile('functions/api/_notify.ts', 'utf8');
  assert.ok(!/api\.telegram\.org|brevo|fetch\(/.test(source));
});

test('mock Telegram transport delivers concise source-linked notifications and marks them sent', async () => {
  const { db, sqlite } = await setup();
  try {
    const prepared = await notify.prepareNotifications(db, 'a');
    assert.equal(prepared.items.length, 2);
    const mock = notify.createMockTelegramTransport();
    const delivery = await notify.deliverPending(db, 'a', mock);
    assert.equal(delivery.sent, 2);
    assert.equal(delivery.failed, 0);
    assert.equal(mock.messages.length, 1);
    const message = mock.messages[0];
    assert.match(message, /قرار جديد لتراخيص البناء في إدلب/);
    assert.match(message, /سانا/);
    assert.match(message, /https:\/\/news\.example\.org\/idlib/);
    assert.match(message, /https:\/\/direct\.example\.org\/idlib/);
    assert.ok(message.length < 1200);
    for (const row of sqlite.prepare("SELECT status, sent_at FROM notifications WHERE subscriber_id='a'").all()) {
      assert.equal(row.status, 'sent');
      assert.ok(row.sent_at);
    }
    const again = await notify.deliverPending(db, 'a', mock);
    assert.equal(again.sent, 0);
    assert.equal(mock.messages.length, 1);
  } finally { sqlite.close(); }
});

test('failed delivery stays failed and a retry succeeds exactly once', async () => {
  const { db, sqlite } = await setup();
  try {
    await notify.prepareNotifications(db, 'a');
    const failing = notify.createMockTelegramTransport({ failError: 'mock outage' });
    const failed = await notify.deliverPending(db, 'a', failing);
    assert.equal(failed.sent, 0);
    assert.ok(failed.failed >= 1);
    assert.equal(failing.messages.length, 0);
    const failedRows = sqlite.prepare("SELECT status, sent_at, error FROM notifications WHERE subscriber_id='a'").all();
    for (const row of failedRows) {
      assert.equal(row.status, 'failed');
      assert.equal(row.sent_at, null);
      assert.equal(row.error, 'mock outage');
    }
    const ok = notify.createMockTelegramTransport();
    const retried = await notify.deliverPending(db, 'a', ok);
    assert.equal(retried.sent, failedRows.length);
    assert.equal(ok.messages.length, 1);
    for (const row of sqlite.prepare("SELECT status, error, sent_at FROM notifications WHERE subscriber_id='a'").all()) {
      assert.equal(row.status, 'sent');
      assert.equal(row.error, null);
      assert.ok(row.sent_at);
    }
    const noDup = await notify.deliverPending(db, 'a', ok);
    assert.equal(noDup.sent, 0);
    assert.equal(ok.messages.length, 1);
  } finally { sqlite.close(); }
});

test('selecting a notification returns only stored details', async () => {
  const { db, sqlite } = await setup();
  try {
    const prepared = await notify.prepareNotifications(db, 'a');
    const list = await notify.listNotifications(db, 'a');
    assert.equal(list.length, prepared.items.length);
    const target = list.find((x) => x.title === 'قرار جديد لتراخيص البناء في إدلب');
    assert.ok(target);
    const details = await notify.notificationDetails(db, 'a', target.id);
    assert.ok(details);
    assert.match(details.text, /قرار جديد لتراخيص البناء في إدلب/);
    assert.match(details.text, /سانا/);
    assert.match(details.text, /2026-11-20/);
    assert.match(details.text, /https:\/\/news\.example\.org\/idlib/);
    assert.equal(details.status, 'prepared');
    // Owner-scoped and never invented.
    assert.equal(await notify.notificationDetails(db, 'b', target.id), null);
    assert.equal(await notify.notificationDetails(db, 'a', 'missing'), null);
    const dPrepared = await notify.prepareNotifications(db, 'd');
    const dDetails = await notify.notificationDetails(db, 'd', dPrepared.items[0].id);
    assert.ok(dDetails && !/\d{4}-\d{2}-\d{2}/.test(dDetails.text));
    assert.match(dDetails.text, /حمص اليوم/);
  } finally { sqlite.close(); }
});

async function runNotifyRoute(db, secret, body) {
  const headers = { 'content-type': 'application/json' };
  if (secret) headers['x-cron-secret'] = secret;
  const req = new Request('https://example.test/api/notify', { method: 'POST', headers, body: JSON.stringify(body ?? {}) });
  const res = await notifyRoute.onRequestPost({ request: req, env: { DB: db, CRON_SECRET: 'cron-secret' }, params: {}, waitUntil() {} });
  return { status: res.status, body: await res.json() };
}

test('protected notify workflow dry-runs by default and simulates without external calls', async () => {
  const { db, sqlite } = await setup();
  try {
    assert.equal((await runNotifyRoute(db, null, { subscriber_id: 'a' })).status, 401);
    const dry = await runNotifyRoute(db, 'cron-secret', { subscriber_id: 'a' });
    assert.equal(dry.status, 200);
    assert.equal(dry.body.dryRun, true);
    assert.equal(dry.body.simulated, false);
    assert.equal(dry.body.messages.length, 0);
    assert.ok(dry.body.prepared >= 1);
    assert.equal(sqlite.prepare("SELECT count(*) n FROM notifications WHERE status='sent'").get().n, 0);

    const simulated = await runNotifyRoute(db, 'cron-secret', { subscriber_id: 'a', simulate: true });
    assert.equal(simulated.status, 200);
    assert.equal(simulated.body.simulated, true);
    assert.equal(simulated.body.dryRun, false);
    assert.equal(simulated.body.sent, 0);
    assert.equal(simulated.body.messages.length, 1);
    assert.match(simulated.body.messages[0], /https:\/\//);
    assert.equal(sqlite.prepare("SELECT count(*) n FROM notifications WHERE status='sent'").get().n, 0);
    assert.ok(sqlite.prepare("SELECT count(*) n FROM notifications WHERE status='prepared'").get().n >= 1);
  } finally { sqlite.close(); }
});
