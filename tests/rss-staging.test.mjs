import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { loadStagingMiddleware, openDatabase } from '../scripts/discovery-runtime.mjs';

const middleware = await loadStagingMiddleware();
const middlewareSource = await readFile('functions/_middleware.ts', 'utf8');
// The middleware file is write-protected in this environment; the tests are
// staged and activate automatically once the owner applies the patch from
// scripts/RSS_STAGING_MIDDLEWARE_PATCH.md. Until then they are skipped
// honestly instead of passing against an unpatched file.
const patchApplied = /env\.RSS_STAGING_MODE\s*===\s*(['"])1\1/.test(middlewareSource);

const stageId = '71340955-16e4-48f1-b228-97490d886403';
const origin = 'https://dialsyria-staging.pages.dev';
const previewOrigin = 'https://abc123d4.dialsyria-staging.pages.dev';

async function rssEnv(overrides = {}) {
  const { db, sqlite } = await openDatabase(':memory:');
  sqlite.exec(await readFile('schema.sql', 'utf8'));
  sqlite.prepare('INSERT INTO rate_limits(key,window,count) VALUES(?,?,1)').run('staging-db:' + stageId, 'staging-only');
  const env = {
    DB: db,
    STAGING_PILOT_MODE: '1',
    RSS_STAGING_MODE: '1',
    SITE_URL: origin,
    STAGING_D1_ID: stageId,
    ALLOW_MOCK_DISCOVERY: '0',
    TELEGRAM_DELIVERY_ENABLED: '0',
    BETA_SCHEDULED_DELIVERY_ENABLED: '0',
    ...overrides,
  };
  return { db, sqlite, env };
}

const call = (env, url = origin + '/api/news', method = 'GET') =>
  middleware.onRequest({ request: new Request(url, { method }), env, next: async () => new Response('next-ok') });

test('rss staging mode allows only GET /api/news and the two cron posts, with no Telegram/Beta credentials', { skip: patchApplied ? false : 'middleware patch from scripts/RSS_STAGING_MIDDLEWARE_PATCH.md not applied yet' }, async () => {
  const { sqlite, env } = await rssEnv();
  try {
    // The env deliberately contains no TELEGRAM_BOT/TOKEN/WEBHOOK_SECRET,
    // no ADMIN_PASSWORD and no Beta allowlists: RSS mode must not need them.
    assert.equal(env.TELEGRAM_BOT, undefined);
    assert.equal(env.TELEGRAM_BOT_TOKEN, undefined);
    assert.equal(env.BETA_ALLOWED_TELEGRAM_IDS, undefined);
    const news = await call(env);
    assert.equal(news.status, 200);
    assert.equal(await news.text(), 'next-ok');
    const ingest = await call(env, origin + '/api/ingest', 'POST');
    assert.equal(ingest.status, 200);
    const digest = await call(env, origin + '/api/digest', 'POST');
    assert.equal(digest.status, 200);
    // Front-end assets are not API paths and stay reachable.
    const home = await call(env, origin + '/');
    assert.equal(home.status, 200);
  } finally { sqlite.close(); }
});

test('rss staging mode rejects wrong hosts including production and arbitrary domains', { skip: patchApplied ? false : 'middleware patch from scripts/RSS_STAGING_MIDDLEWARE_PATCH.md not applied yet' }, async () => {
  const { sqlite, env } = await rssEnv();
  try {
    assert.equal((await call(env, 'https://dial-syria.pages.dev/api/news')).status, 503);
    assert.equal((await call(env, 'https://dialsyria.pages.dev/api/news')).status, 503);
    assert.equal((await call(env, 'https://example.com/api/news')).status, 503);
    // Deployment preview subdomains of the staging project are allowed.
    assert.equal((await call(env, previewOrigin + '/api/news')).status, 200);
  } finally { sqlite.close(); }
});

test('rss staging mode fails closed without pilot mode, matching SITE_URL or safe flags', { skip: patchApplied ? false : 'middleware patch from scripts/RSS_STAGING_MIDDLEWARE_PATCH.md not applied yet' }, async () => {
  const { sqlite, env } = await rssEnv();
  try {
    assert.equal((await call({ ...env, STAGING_PILOT_MODE: '0' })).status, 503);
    assert.equal((await call({ ...env, STAGING_PILOT_MODE: undefined })).status, 503);
    assert.equal((await call({ ...env, SITE_URL: 'https://dial-syria.pages.dev' })).status, 503);
    assert.equal((await call({ ...env, ALLOW_MOCK_DISCOVERY: '1' })).status, 503);
    assert.equal((await call({ ...env, TELEGRAM_DELIVERY_ENABLED: '1' })).status, 503);
    assert.equal((await call({ ...env, BETA_SCHEDULED_DELIVERY_ENABLED: '1' })).status, 503);
    assert.equal((await call({ ...env, TELEGRAM_DELIVERY_ENABLED: undefined })).status, 503);
  } finally { sqlite.close(); }
});

test('rss staging mode keeps the database isolation check: id, production id and marker', { skip: patchApplied ? false : 'middleware patch from scripts/RSS_STAGING_MIDDLEWARE_PATCH.md not applied yet' }, async () => {
  const { db, sqlite, env } = await rssEnv();
  try {
    await db.prepare('DELETE FROM rate_limits WHERE key=?').bind('staging-db:' + stageId).run();
    assert.equal((await call(env)).status, 503); // marker missing
    await db.prepare('INSERT INTO rate_limits(key,window,count) VALUES(?,?,1)').bind('staging-db:' + stageId, 'staging-only').run();
    assert.equal((await call(env, origin + '/api/news')).status, 200);
    assert.equal((await call({ ...env, STAGING_D1_ID: 'not-a-uuid' })).status, 503);
    assert.equal((await call({ ...env, STAGING_D1_ID: '44b3a09f-8f64-4ea0-81e1-d79bc4af7575' })).status, 503); // production database id
    const noDb = { ...env }; delete noDb.DB;
    assert.equal((await call(noDb)).status, 503);
  } finally { sqlite.close(); }
});

test('rss staging mode blocks Beta, Telegram, registration, admin and every other API route', { skip: patchApplied ? false : 'middleware patch from scripts/RSS_STAGING_MIDDLEWARE_PATCH.md not applied yet' }, async () => {
  const { sqlite, env } = await rssEnv();
  try {
    const blocked = [
      ['POST', '/api/notify'],
      ['POST', '/api/beta'],
      ['GET', '/api/beta'],
      ['POST', '/api/beta-scheduled'],
      ['POST', '/api/telegram'],
      ['POST', '/api/telegram/link'],
      ['POST', '/api/subscribe'],
      ['POST', '/api/login'],
      ['GET', '/api/me'],
      ['PATCH', '/api/me'],
      ['DELETE', '/api/interests'],
      ['POST', '/api/interests/discover'],
      ['POST', '/api/admin/subscribers'],
      ['GET', '/api/admin/subscribers'],
      ['POST', '/api/direct'],
      ['POST', '/api/news'],
      ['DELETE', '/api/news'],
    ];
    for (const [method, path] of blocked) {
      const res = await call(env, origin + path, method);
      assert.equal(res.status, 404, path);
      assert.deepEqual(await res.json(), { error: 'route not available in rss staging mode' });
    }
  } finally { sqlite.close(); }
});

test('the legacy Beta pilot protection still works when RSS mode is off', async () => {
  const { db, sqlite, env } = await rssEnv({ RSS_STAGING_MODE: undefined, TELEGRAM_BOT: 'DedicatedStageBot', TELEGRAM_BOT_TOKEN: '123456:' + 'a'.repeat(35), TELEGRAM_WEBHOOK_SECRET: 'webhook-secret-'.repeat(3), ADMIN_PASSWORD: 'local-test-password-not-real', BETA_ALLOWED_TELEGRAM_IDS: '101', TELEGRAM_TEST_CHAT_IDS: '101' });
  try {
    const callLegacy = (path) => middleware.onRequest({ request: new Request(origin + path), env, next: async () => new Response('legacy-ok') });
    assert.equal((await callLegacy('/beta')).status, 200); // legacy pilot guard intact
    assert.equal((await callLegacy('/manage?token=redacted')).status, 403);
    assert.equal((await callLegacy('/api/login')).status, 403);
    assert.equal((await callLegacy('/api/notify')).status, 200); // notify stays reachable in legacy pilot mode
    // Production is untouched: without the staging pilot flag the middleware passes through.
    const prod = await middleware.onRequest({ request: new Request('https://dial-syria.pages.dev/'), env: { DB: db }, next: async () => new Response('prod-ok') });
    assert.equal(prod.status, 200);
  } finally { sqlite.close(); }
});
