import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { loadEngine, loadInterests, loadNotify, openDatabase } from '../scripts/discovery-runtime.mjs';

const api = await loadInterests();
const engine = await loadEngine();
const notify = await loadNotify();

const INTEREST = 'قرارات البناء والتراخيص في إدلب';

test('isPublisherVerified requires a positive title match and rejects conflicts', () => {
  assert.equal(notify.isPublisherVerified('publisher_metadata; title_match'), true);
  assert.equal(notify.isPublisherVerified('publisher_metadata; title_match; dates_consistent_48h'), true);
  assert.equal(notify.isPublisherVerified('publisher_metadata; title_mismatch'), false);
  assert.equal(notify.isPublisherVerified('publisher_metadata'), false); // missing evidence
  assert.equal(notify.isPublisherVerified('publisher_metadata; title_match; date_mismatch'), false);
  assert.equal(notify.isPublisherVerified('not_attempted'), false);
  assert.equal(notify.isPublisherVerified(null), false);
});

test('prepareNotifications excludes title/date conflicts and missing evidence', async () => {
  const { db, sqlite } = await openDatabase(':memory:');
  sqlite.exec(await readFile('schema.sql', 'utf8'));
  sqlite.prepare('INSERT INTO subscribers (id,email,status,created_at) VALUES (?,?,?,?)').run('a', 'a@example.test', 'active', '2026-01-01');
  sqlite.prepare('INSERT INTO subscriber_interests (id,subscriber_id,text,normalized_text,created_at,updated_at) VALUES (?,?,?,?,?,?)')
    .run('int-a', 'a', INTEREST, api.normalizeInterest(INTEREST), '2026-01-01', '2026-01-01');
  const key = engine.normalize(INTEREST);
  const item = (id, verification) => {
    sqlite.prepare('INSERT INTO discovery_items (id,url,title_key,title,description,source,published_at,discovered_at,source_host,is_mock,publisher_published_at,original_url,verification_status) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)')
      .run(id, 'https://news.example.org/' + id, 'key-' + id, 'قرار تراخيص البناء في إدلب', 'نص الخبر.', 'سانا', '2026-11-20T09:00:00.000Z', '2026-11-21T00:00:00.000Z', 'news.example.org', 0, '2026-11-20T09:00:00.000Z', 'https://news.example.org/' + id, verification);
    sqlite.prepare('INSERT INTO discovery_item_interests (interest_key,item_id,score) VALUES (?,?,?)').run(key, id, 0.9);
  };
  item('good', 'publisher_metadata; title_match');
  item('mismatch', 'publisher_metadata; title_mismatch');
  item('missing', 'publisher_metadata');
  item('dateConflict', 'publisher_metadata; title_match; date_mismatch');

  const result = await notify.prepareNotifications(db, 'a');
  assert.equal(result.items.length, 1);
  assert.equal(result.items[0].itemId, 'good');
  // Previously stored questionable rows are excluded, never deleted.
  assert.equal(sqlite.prepare('SELECT count(*) n FROM discovery_items').get().n, 4);
  assert.equal(sqlite.prepare("SELECT count(*) n FROM discovery_items WHERE verification_status='publisher_metadata; title_mismatch'").get().n, 1);
  sqlite.close();
});
