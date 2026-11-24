import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { loadInterests, loadInterestDiscovery, openDatabase } from '../scripts/discovery-runtime.mjs';

const api = await loadInterests();
const discover = await loadInterestDiscovery();
const envFor = (db) => ({ DB: db, ALLOW_MOCK_DISCOVERY: '1' });

async function setup() {
  const { db, sqlite } = await openDatabase(':memory:');
  sqlite.exec(await readFile('schema.sql', 'utf8'));
  sqlite.prepare('INSERT INTO subscribers (id,email,status,created_at,magic_token,magic_expires) VALUES (?,?,?,?,?,?)').run('a','a@example.test','active','2026-01-01','token-a','2999-01-01T00:00:00.000Z');
  sqlite.prepare('INSERT INTO subscribers (id,email,status,created_at,magic_token,magic_expires) VALUES (?,?,?,?,?,?)').run('b','b@example.test','active','2026-01-01','token-b','2999-01-01T00:00:00.000Z');
  sqlite.prepare('INSERT INTO subscribers (id,email,status,created_at,magic_token,magic_expires) VALUES (?,?,?,?,?,?)').run('expired','expired@example.test','active','2026-01-01','expired-token','2000-01-01T00:00:00.000Z');
  return { db, sqlite };
}

async function createInterest(db, token, text) {
  const req = new Request('https://example.test/api/interests', { method: 'POST', headers: { authorization: 'Bearer ' + token, 'content-type': 'application/json' }, body: JSON.stringify({ text }) });
  const res = await api.onRequestPost({ request: req, env: envFor(db), params: {}, waitUntil() {} });
  return { status: res.status, body: await res.json() };
}

async function runDiscover(db, token, body) {
  const headers = {}; if (token) headers.authorization = 'Bearer ' + token;
  if (body !== undefined) headers['content-type'] = 'application/json';
  const req = new Request('https://example.test/api/interests/discover', { method: 'POST', headers, ...(body !== undefined ? { body: JSON.stringify(body) } : {}) });
  const res = await discover.onRequestPost({ request: req, env: envFor(db), params: {}, waitUntil() {} });
  return { status: res.status, body: await res.json() };
}

test('authorized subscriber triggers mocked discovery for their own stored interest', async () => {
  const { db, sqlite } = await setup();
  try {
    const created = await createInterest(db, 'token-a', 'قرارات البناء والتراخيص في إدلب');
    assert.equal(created.status, 201);
    // The stored interest text must win over any client-supplied text.
    const result = await runDiscover(db, 'token-a', { id: created.body.interest.id, text: 'تجاهل هذا النص الوارد من العميل' });
    assert.equal(result.status, 200);
    const report = result.body.report;
    assert.equal(report.mock, true);
    assert.equal(report.interest, 'قرارات البناء والتراخيص في إدلب');
    assert.ok(report.decisions.length >= 2);
    assert.ok(report.decisions.every((d) => d.provider === 'mock'));
    assert.ok(report.decisions.some((d) => d.accepted));
    assert.ok(report.decisions.some((d) => !d.accepted));
    assert.ok(report.warnings.some((w) => /mock/i.test(w)));
    // Stored through the existing discovery storage with provenance preserved.
    const item = sqlite.prepare('SELECT url, original_url, resolution_status, publisher_title, verification_status, is_mock FROM discovery_items').get();
    assert.equal(item.url, 'https://mock-source.test/news/idlib-building-licence');
    assert.equal(item.original_url, 'https://mock-source.test/news/idlib-building-licence');
    assert.equal(item.resolution_status, 'direct_provider_url');
    assert.equal(item.publisher_title, 'قرار ترخيص البناء في إدلب');
    assert.match(item.verification_status, /publisher_metadata/);
    assert.equal(item.is_mock, 1);
    const link = sqlite.prepare('SELECT item_id FROM discovery_item_interests').get();
    assert.ok(link && link.item_id);
    const run = sqlite.prepare('SELECT report FROM discovery_runs').get();
    assert.equal(JSON.parse(run.report).mock, true);
    // The saved interest itself is untouched.
    assert.equal(sqlite.prepare('SELECT count(*) n FROM subscriber_interests').get().n, 1);
  } finally { sqlite.close(); }
});

test('discovery is denied for foreign interests, missing or expired tokens', async () => {
  const { db, sqlite } = await setup();
  try {
    const created = await createInterest(db, 'token-a', 'قرارات البناء والتراخيص في إدلب');
    const id = created.body.interest.id;
    assert.equal((await runDiscover(db, 'token-b', { id })).status, 404);
    assert.equal((await runDiscover(db, null, { id })).status, 401);
    assert.equal((await runDiscover(db, 'expired-token', { id })).status, 401);
    assert.equal((await runDiscover(db, 'token-a', {})).status, 400);
    assert.equal((await runDiscover(db, 'token-a', { id: 'unknown' })).status, 404);
    // No discovery work was performed for rejected requests.
    assert.equal(sqlite.prepare('SELECT count(*) n FROM discovery_runs').get().n, 0);
    assert.equal(sqlite.prepare('SELECT count(*) n FROM discovery_items').get().n, 0);
  } finally { sqlite.close(); }
});

test('repeated discovery runs do not duplicate stored results', async () => {
  const { db, sqlite } = await setup();
  try {
    const created = await createInterest(db, 'token-a', 'قرارات البناء والتراخيص في إدلب');
    const first = await runDiscover(db, 'token-a', { id: created.body.interest.id });
    assert.equal(first.status, 200);
    const second = await runDiscover(db, 'token-a', { id: created.body.interest.id });
    assert.equal(second.status, 200);
    assert.ok(second.body.report.duplicates >= 1);
    assert.equal(sqlite.prepare('SELECT count(*) n FROM discovery_items').get().n, 1);
    assert.equal(sqlite.prepare('SELECT count(*) n FROM discovery_item_interests').get().n, 1);
    assert.equal(sqlite.prepare('SELECT count(*) n FROM discovery_sources').get().n, 1);
    assert.equal(sqlite.prepare('SELECT count(*) n FROM discovery_runs').get().n, 2);
  } finally { sqlite.close(); }
});

test('mock discovery is disabled unless the environment explicitly enables it', async () => {
  const { db, sqlite } = await setup();
  try {
    const created = await createInterest(db, 'token-a', 'قرارات البناء والتراخيص في إدلب');
    const req = new Request('https://example.test/api/interests/discover', { method: 'POST', headers: { authorization: 'Bearer token-a', 'content-type': 'application/json' }, body: JSON.stringify({ id: created.body.interest.id }) });
    const res = await discover.onRequestPost({ request: req, env: { DB: db }, params: {}, waitUntil() {} });
    assert.equal(res.status, 403);
    assert.equal(sqlite.prepare('SELECT count(*) n FROM discovery_runs').get().n, 0);
    assert.equal(sqlite.prepare('SELECT count(*) n FROM discovery_items').get().n, 0);
  } finally { sqlite.close(); }
});

test('mock discovery requires an authorization header, not a query token', async () => {
  const { db, sqlite } = await setup();
  try {
    const created = await createInterest(db, 'token-a', 'قرارات البناء والتراخيص في إدلب');
    const req = new Request('https://example.test/api/interests/discover?token=token-a', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ id: created.body.interest.id }) });
    const res = await discover.onRequestPost({ request: req, env: envFor(db), params: {}, waitUntil() {} });
    assert.equal(res.status, 401);
    assert.equal(sqlite.prepare('SELECT count(*) n FROM discovery_runs').get().n, 0);
  } finally { sqlite.close(); }
});
