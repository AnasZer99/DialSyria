import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { loadEngine, loadInterests, loadNotify, openDatabase } from '../scripts/discovery-runtime.mjs';

const api = await loadInterests();
const engine = await loadEngine();
const notify = await loadNotify();

const INTEREST = 'قرارات البناء والتراخيص في إدلب';
const FUTURE = '2999-01-01T00:00:00.000Z';
const PAST = '2000-01-01T00:00:00.000Z';

async function setupWithStatus(status, { trialEndsAt = null, expiresAt = null } = {}) {
  const { db, sqlite } = await openDatabase(':memory:');
  sqlite.exec(await readFile('schema.sql', 'utf8'));
  sqlite.prepare('INSERT INTO subscribers (id,email,status,created_at,trial_ends_at,expires_at) VALUES (?,?,?,?,?,?)')
    .run('s', 's@example.test', status, '2026-01-01', trialEndsAt, expiresAt);
  sqlite.prepare('INSERT INTO subscriber_interests (id,subscriber_id,text,normalized_text,created_at,updated_at) VALUES (?,?,?,?,?,?)')
    .run('int-s', 's', INTEREST, api.normalizeInterest(INTEREST), '2026-01-01', '2026-01-01');
  const key = engine.normalize(INTEREST);
  sqlite.prepare('INSERT INTO discovery_items (id,url,title_key,title,description,source,published_at,discovered_at,source_host,is_mock,publisher_published_at,original_url,verification_status) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)')
    .run('it', 'https://news.example.org/it', 'key-it', 'قرار تراخيص البناء في إدلب', 'نص', 'سانا', '2026-11-20T09:00:00.000Z', '2026-11-21T00:00:00.000Z', 'news.example.org', 0, '2026-11-20T09:00:00.000Z', 'https://news.example.org/it', 'publisher_metadata; title_match');
  sqlite.prepare('INSERT INTO discovery_item_interests (interest_key,item_id,score) VALUES (?,?,?)').run(key, 'it', 0.9);
  return { db, sqlite };
}

test('eligible and ineligible subscriber states are enforced at preparation and delivery', async () => {
  const cases = [
    ['active', {}, true],
    ['trial', { trialEndsAt: FUTURE }, true],
    ['trial', { trialEndsAt: PAST }, false],
    ['active', { expiresAt: PAST }, false],
    ['cancelled', {}, false],
    ['expired', {}, false],
    ['paused', {}, false],
    ['pending', {}, false],
  ];
  for (const [status, extra, eligible] of cases) {
    const { db, sqlite } = await setupWithStatus(status, extra);
    const prepared = await notify.prepareNotifications(db, 's');
    assert.equal(prepared.items.length, eligible ? 1 : 0, `${status} prepare`);
    const delivery = await notify.deliverPending(db, 's', notify.createMockTelegramTransport());
    assert.equal(delivery.sent, eligible ? 1 : 0, `${status} delivery`);
    sqlite.close();
  }
});

test('a subscriber who becomes ineligible after preparation is not sent', async () => {
  const { db, sqlite } = await setupWithStatus('active');
  const prepared = await notify.prepareNotifications(db, 's');
  assert.equal(prepared.items.length, 1);
  // Become cancelled after preparation.
  sqlite.prepare("UPDATE subscribers SET status='cancelled' WHERE id='s'").run();
  const transport = notify.createMockTelegramTransport();
  const delivery = await notify.deliverPending(db, 's', transport);
  assert.equal(delivery.sent, 0);
  assert.equal(transport.messages.length, 0);
  // The row stays prepared (never claimed/sent), so re-activation would deliver it.
  assert.equal(sqlite.prepare("SELECT status, sent_at FROM notifications WHERE subscriber_id='s'").get().status, 'prepared');
  assert.equal(sqlite.prepare("SELECT sent_at FROM notifications WHERE subscriber_id='s'").get().sent_at, null);
  sqlite.close();
});
