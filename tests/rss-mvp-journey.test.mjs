import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { openDatabase } from '../scripts/discovery-runtime.mjs';

// Load the real MVP journey modules exactly as Pages would route them.
async function bundle(entry) {
  const { build } = await import('esbuild');
  const result = await build({ entryPoints: [entry], bundle: true, platform: 'neutral', format: 'esm', write: false });
  return import('data:text/javascript;base64,' + Buffer.from(result.outputFiles[0].contents).toString('base64'));
}

const subscribe = await bundle('functions/api/subscribe.ts');
const webhook = await bundle('functions/api/telegram-mvp.ts');
const digestRoute = await bundle('functions/api/digest.ts');
const adminSubs = await bundle('functions/api/admin/subscribers.ts');
const adminLogin = await bundle('functions/api/admin/login.ts');

const ADMIN_PASSWORD = 'local-admin-password-not-real-1234';
const MVP_SECRET = 'mvp-webhook-secret-test-only';
const ctx = (request, env) => ({ request, env, params: {}, waitUntil() {} });
const DAY = 86400000;
const now = Date.now();
const iso = (ms) => new Date(now + ms).toISOString();

const SEED_ARTICLES = [
  { title: 'افتتاح مشروع مياه حكومي جديد في دمشق', url: 'https://sana.example/water', source: 'سانا', topic: 'politics', scope: 'syria', published: iso(-2 * 3600000) },
  { title: 'ارتفاع أسعار النفط في الأسواق العالمية', url: 'https://bbc.example/oil', source: 'BBC عربي', topic: 'economy', scope: 'global', published: iso(-3 * 3600000) },
  { title: 'منتخب سوريا يخوض مباراة ودية في دمشق', url: 'https://aljazeera.example/football', source: 'الجزيرة نت', topic: 'sports', scope: 'syria', published: iso(-4 * 3600000) },
];

async function makeEnv(overrides = {}) {
  const { db, sqlite } = await openDatabase(':memory:');
  sqlite.exec(await readFile('schema.sql', 'utf8'));
  for (const a of SEED_ARTICLES) {
    db.prepare('INSERT INTO articles (id,title,summary,url,source,topic,scope,published_at,fetched_at) VALUES (?,?,?,?,?,?,?,?,?)')
      .bind(crypto.randomUUID(), a.title, 'ملخّص واقعي مخزّن من التغذية فقط.', a.url, a.source, a.topic, a.scope, a.published, a.published)
      .run();
  }
  const env = {
    DB: db,
    RSS_MVP_MODE: '1',
    TELEGRAM_MVP_BOT: 'DialSyriaMVPBot',
    TELEGRAM_MVP_BOT_TOKEN: '000000000:AA-mock-token-not-real-XXXXXXXXXXX',
    TELEGRAM_MVP_WEBHOOK_SECRET: MVP_SECRET,
    ADMIN_PASSWORD: ADMIN_PASSWORD,
    CRON_SECRET: 'cron-secret-local',
    ...overrides,
  };
  return { db, sqlite, env };
}

/** Telegram webhook caller with the real MVP secret header. */
function tg(env, payload, headers = {}) {
  const request = new Request('https://dial.test/api/telegram-mvp', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-telegram-bot-api-secret-token': MVP_SECRET, ...headers },
    body: JSON.stringify(payload),
  });
  return webhook.onRequestPost(ctx(request, env));
}

/** Installs a mocked Telegram transport that records every outbound message. */
function mockTelegram() {
  const messages = [];
  const original = globalThis.fetch;
  globalThis.fetch = async (input, init) => {
    const url = String(input);
    if (!url.startsWith('https://api.telegram.org/')) throw new Error('unexpected external call: ' + url);
    messages.push({ url, body: JSON.parse(init.body) });
    return new Response(JSON.stringify({ ok: true, result: { message_id: messages.length } }), { status: 200 });
  };
  return { messages, restore: () => { globalThis.fetch = original; } };
}

async function subscribePending(env, email, topics = ['politics', 'economy']) {
  const request = new Request('https://dial.test/api/subscribe', {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email, topics, delivery_hour: 7, language: 'ar' }),
  });
  const res = await subscribe.onRequestPost(ctx(request, env));
  const body = await res.json();
  return { res, body };
}

async function adminToken(env) {
  const res = await adminLogin.onRequestPost(ctx(new Request('https://dial.test/api/admin/login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ password: ADMIN_PASSWORD }) }), env));
  return (await res.json()).token;
}

const adminList = (env, token) => adminSubs.onRequestGet(ctx(new Request('https://dial.test/api/admin/subscribers', { headers: { authorization: 'Bearer ' + token } }), env));
const adminAct = (env, token, id, action) => adminSubs.onRequestPost(ctx(new Request('https://dial.test/api/admin/subscribers', { method: 'POST', headers: { authorization: 'Bearer ' + token, 'content-type': 'application/json' }, body: JSON.stringify({ id, action }) }), env));

// ——— AC-02/AC-03: pending request without payment, email or takeover ———

test('AC-02: MVP subscribe creates a pending request with a pairing code, no payment, no email', async () => {
  const { db, sqlite, env } = await makeEnv();
  try {
    const { res, body } = await subscribePending(env, 'reader@example.test');
    assert.equal(res.status, 200);
    assert.equal(body.status, 'pending');
    assert.ok(body.telegram.code.length >= 8);
    assert.equal(body.telegram.bot, 'DialSyriaMVPBot');
    assert.equal(body.manage_url, undefined, 'no manage link: email alone must not unlock an account');
    const row = sqlite.prepare("SELECT status, trial_ends_at, expires_at, magic_token, telegram_chat_id FROM subscribers WHERE email='reader@example.test'").get();
    assert.equal(row.status, 'pending');
    assert.equal(row.trial_ends_at, null, 'no trial');
    assert.equal(row.magic_token, null, 'no magic token to steal');
    assert.equal(row.telegram_chat_id, null);
    const topics = sqlite.prepare("SELECT topic FROM subscriber_topics WHERE subscriber_id=(SELECT id FROM subscribers WHERE email='reader@example.test')").all().map((r) => r.topic);
    assert.deepEqual(new Set(topics), new Set(['politics', 'economy']));
  } finally { sqlite.close(); }
});

test('AC-03: duplicate email never creates a second account and leaks no token', async () => {
  const { db, sqlite, env } = await makeEnv();
  try {
    await subscribePending(env, 'reader@example.test');
    const second = await subscribePending(env, 'reader@example.test');
    assert.equal(second.res.status, 200);
    assert.equal(second.body.status, 'existing');
    assert.equal(second.body.telegram, undefined, 'no pairing code for an unverified duplicate');
    assert.equal(sqlite.prepare('SELECT COUNT(*) n FROM subscribers').get().n, 1);
    assert.equal(sqlite.prepare('SELECT COUNT(*) n FROM rss_link_codes').get().n, 1);
  } finally { sqlite.close(); }
});

test('AC-03b: subscription request rate limit returns 429', async () => {
  const { db, sqlite, env } = await makeEnv();
  try {
    let last;
    for (let i = 0; i < 5; i++) last = await subscribePending(env, `reader${i}@example.test`);
    assert.equal(last.res.status, 200);
    const blocked = await subscribePending(env, 'reader5@example.test');
    assert.equal(blocked.res.status, 429);
    assert.equal(sqlite.prepare('SELECT COUNT(*) n FROM subscribers').get().n, 5);
  } finally { sqlite.close(); }
});

// ——— AC-04: admin routes are backend-authenticated ———

test('AC-04: unauthenticated admin calls are 401', async () => {
  const { db, sqlite, env } = await makeEnv();
  try {
    assert.equal((await adminList(env, '')).status, 401);
    assert.equal((await adminList(env, 'forged-token')).status, 401);
    const forged = await adminAct(env, 'forged-token', 'whatever', 'approve');
    assert.equal(forged.status, 401);
  } finally { sqlite.close(); }
});

// ——— AC-05/AC-06: admin reviews, approves, stops, pauses, resumes, renews ———

test('AC-05/06: admin approves pending → active; /stop; pause/resume; idempotent approve; renew extends', async () => {
  const { db, sqlite, env } = await makeEnv();
  const mock = mockTelegram();
  try {
    const { body } = await subscribePending(env, 'reader@example.test');
    const subId = sqlite.prepare("SELECT id FROM subscribers WHERE email='reader@example.test'").get().id;
    const token = await adminToken(env);
    const list = await (await adminList(env, token)).json();
    const row = list.subscribers.find((s) => s.id === subId);
    assert.equal(row.status, 'pending');
    assert.equal(row.telegram_linked, false);
    assert.equal(row.topics.includes('economy'), true);

    assert.equal((await adminAct(env, token, 'no-such-id', 'approve')).status, 404);
    const approve1 = await (await adminAct(env, token, subId, 'approve')).json();
    assert.equal(approve1.status, 'active');
    const approve2 = await (await adminAct(env, token, subId, 'approve')).json(); // double-click safe
    assert.equal(approve2.already, true);
    const after = sqlite.prepare("SELECT status, expires_at FROM subscribers WHERE id=?").get(subId);
    assert.equal(after.status, 'active');
    assert.ok(new Date(after.expires_at).getTime() - Date.now() > 29 * DAY);

    // Link chat 777 through the pairing code (design: /stop only works on a
    // linked chat), then /stop: stops delivery, erases nothing.
    await tg(env, { message: { text: `/start ${body.telegram.code}`, chat: { id: 777, type: 'private' }, from: { id: 777 } } });
    mock.messages.length = 0;
    await tg(env, { message: { text: '/stop', chat: { id: 777, type: 'private' }, from: { id: 777 } } });
    assert.equal(sqlite.prepare('SELECT paused FROM rss_telegram_prefs WHERE subscriber_id=?').get(subId).paused, 1);
    // admin pause + resume re-activates both subscription and Telegram delivery.
    await adminAct(env, token, subId, 'pause');
    assert.equal(sqlite.prepare("SELECT status FROM subscribers WHERE id=?").get(subId).status, 'paused');
    await adminAct(env, token, subId, 'resume');
    assert.equal(sqlite.prepare("SELECT status FROM subscribers WHERE id=?").get(subId).status, 'active');
    assert.equal(sqlite.prepare('SELECT paused FROM rss_telegram_prefs WHERE subscriber_id=?').get(subId).paused, 0);
    const renewed = await (await adminAct(env, token, subId, 'renew')).json();
    assert.ok(new Date(renewed.expires_at).getTime() > new Date(after.expires_at).getTime());
    assert.equal(mock.messages.length, 1, 'only the /stop confirmation was sent');
    assert.ok(mock.messages[0].body.text.includes('/stop'));
  } finally { mock.restore(); sqlite.close(); }
});

test('AC-05b: admin rejects a pending request without deleting data', async () => {
  const { db, sqlite, env } = await makeEnv();
  try {
    await subscribePending(env, 'rejectme@example.test');
    const subId = sqlite.prepare("SELECT id FROM subscribers WHERE email='rejectme@example.test'").get().id;
    const token = await adminToken(env);
    const res = await (await adminAct(env, token, subId, 'reject')).json();
    assert.equal(res.status, 'cancelled');
    assert.equal(sqlite.prepare("SELECT status FROM subscribers WHERE id=?").get(subId).status, 'cancelled');
    assert.equal(sqlite.prepare('SELECT COUNT(*) n FROM subscribers').get().n, 1);
  } finally { sqlite.close(); }
});

// ——— AC-07: Telegram pairing is private-only, single-use, conflict-safe ———

test('AC-07: /start with a valid code links a private chat exactly once', async () => {
  const { db, sqlite, env } = await makeEnv();
  const mock = mockTelegram();
  try {
    const { body } = await subscribePending(env, 'reader@example.test');
    const code = body.telegram.code;
    assert.equal((await tg(env, { message: { text: `/start ${code}`, chat: { id: 777, type: 'private' }, from: { id: 777 } } }, { 'x-telegram-bot-api-secret-token': 'wrong' })).status, 401);
    // Group chat and spoofed sender are ignored.
    await tg(env, { message: { text: `/start ${code}`, chat: { id: -100, type: 'group' }, from: { id: 777 } } });
    await tg(env, { message: { text: `/start ${code}`, chat: { id: 777, type: 'private' }, from: { id: 999 } } });
    assert.equal(sqlite.prepare("SELECT telegram_chat_id FROM subscribers WHERE email='reader@example.test'").get().telegram_chat_id, null);
    // Correct private pairing.
    await tg(env, { message: { text: `/start ${code}`, chat: { id: 777, type: 'private' }, from: { id: 777 } } });
    assert.equal(sqlite.prepare("SELECT telegram_chat_id FROM subscribers WHERE email='reader@example.test'").get().telegram_chat_id, '777');
    assert.notEqual(sqlite.prepare('SELECT used_at FROM rss_link_codes LIMIT 1').get().used_at, null);
    assert.ok(mock.messages.at(-1).body.text.includes('تم ربط حسابك بنجاح'));
    // Webhook replay: the code is single-use, nothing changes.
    await tg(env, { message: { text: `/start ${code}`, chat: { id: 777, type: 'private' }, from: { id: 777 } } });
    assert.ok(mock.messages.at(-1).body.text.includes('استُخدم مسبقاً'));
    assert.equal(sqlite.prepare("SELECT telegram_chat_id FROM subscribers WHERE email='reader@example.test'").get().telegram_chat_id, '777');
  } finally { mock.restore(); sqlite.close(); }
});

test('AC-07b: a chat already bound to another subscriber cannot be stolen', async () => {
  const { db, sqlite, env } = await makeEnv();
  const mock = mockTelegram();
  try {
    const first = await subscribePending(env, 'first@example.test');
    await tg(env, { message: { text: `/start ${first.body.telegram.code}`, chat: { id: 555, type: 'private' }, from: { id: 555 } } });
    assert.equal(sqlite.prepare("SELECT telegram_chat_id FROM subscribers WHERE email='first@example.test'").get().telegram_chat_id, '555');
    const second = await subscribePending(env, 'second@example.test');
    await tg(env, { message: { text: `/start ${second.body.telegram.code}`, chat: { id: 555, type: 'private' }, from: { id: 555 } } });
    assert.ok(mock.messages.at(-1).body.text.includes('مرتبطة باشتراك آخر'));
    assert.equal(sqlite.prepare("SELECT telegram_chat_id FROM subscribers WHERE email='second@example.test'").get().telegram_chat_id, null);
  } finally { mock.restore(); sqlite.close(); }
});

// ——— AC-08/09/10/11: delivery rules ———

async function activateAndLink(sqlite, email, chatId) {
  const subId = sqlite.prepare('SELECT id FROM subscribers WHERE email=?').get(email).id;
  sqlite.prepare("UPDATE subscribers SET status='active', expires_at=?, telegram_chat_id=? WHERE id=?").run(iso(+30 * DAY), String(chatId), subId);
  return subId;
}

test('AC-08: pending/paused/expired subscribers receive no digest', async () => {
  const { db, sqlite, env } = await makeEnv();
  const mock = mockTelegram();
  try {
    await subscribePending(env, 'pending@example.test');
    sqlite.prepare("UPDATE subscribers SET telegram_chat_id='101' WHERE email='pending@example.test'").run();
    await tg(env, { message: { text: '/news', chat: { id: 101, type: 'private' }, from: { id: 101 } } });
    assert.ok(mock.messages.at(-1).body.text.includes('بانتظار موافقة الإدارة'));

    await subscribePending(env, 'stopped@example.test');
    await activateAndLink(sqlite, 'stopped@example.test', 102);
    await tg(env, { message: { text: '/stop', chat: { id: 102, type: 'private' }, from: { id: 102 } } });
    mock.messages.length = 0;
    await tg(env, { message: { text: '/news', chat: { id: 102, type: 'private' }, from: { id: 102 } } });
    assert.ok(mock.messages.at(-1).body.text.includes('موقوف'));

    sqlite.prepare("UPDATE subscribers SET status='paused' WHERE telegram_chat_id='102'").run();
    await tg(env, { message: { text: '/news', chat: { id: 102, type: 'private' }, from: { id: 102 } } });
    assert.ok(mock.messages.at(-1).body.text.includes('موقوف'));

    assert.equal(sqlite.prepare("SELECT COUNT(*) n FROM digests WHERE status='mvp_sent'").get().n, 0);
    assert.ok(!mock.messages.some((m) => m.body.text.includes('أسعار النفط')), 'no news items reached ineligible accounts');
  } finally { mock.restore(); sqlite.close(); }
});

test('AC-09: approved subscriber receives one digest from stored articles only', async () => {
  const { db, sqlite, env } = await makeEnv();
  const mock = mockTelegram();
  try {
    await subscribePending(env, 'active@example.test');
    await activateAndLink(sqlite, 'active@example.test', 333);
    mock.messages.length = 0;
    await tg(env, { message: { text: '/news', chat: { id: 333, type: 'private' }, from: { id: 333 } } });
    const text = mock.messages.at(-1).body.text;
    assert.ok(text.includes('افتتاح مشروع مياه حكومي جديد في دمشق'), 'syria item present');
    assert.ok(text.includes('ارتفاع أسعار النفط'), 'global/economy item present');
    assert.ok(text.includes('سانا') && text.includes('BBC عربي'), 'publisher names present');
    for (const a of SEED_ARTICLES) {
      if (a.topic === 'sports') continue; // topic not chosen by this subscriber
      assert.ok(text.includes(a.url), 'stored publisher URL kept: ' + a.url);
    }
    const digestRow = sqlite.prepare("SELECT status, articles_count FROM digests WHERE subscriber_id=(SELECT id FROM subscribers WHERE email='active@example.test')").get();
    assert.equal(digestRow.status, 'mvp_sent');
    const last = sqlite.prepare("SELECT last_digest_at FROM subscribers WHERE email='active@example.test'").get().last_digest_at;
    assert.ok(last && Math.abs(Date.parse(last) - Date.now()) < 60000);
  } finally { mock.restore(); sqlite.close(); }
});

test('AC-10: second /news within 24h and a scheduled run cannot double-send', async () => {
  const { db, sqlite, env } = await makeEnv();
  const mock = mockTelegram();
  try {
    await subscribePending(env, 'active@example.test');
    await activateAndLink(sqlite, 'active@example.test', 444);
    await tg(env, { message: { text: '/news', chat: { id: 444, type: 'private' }, from: { id: 444 } } });
    assert.equal(mock.messages.filter((m) => m.body.text.includes('نشرة ديل سيريا')).length, 1);
    mock.messages.length = 0;

    await tg(env, { message: { text: '/news', chat: { id: 444, type: 'private' }, from: { id: 444 } } });
    assert.ok(mock.messages.at(-1).body.text.includes('آخر 24 ساعة'));

    const scheduled = await digestRoute.onRequestPost(ctx(new Request('https://dial.test/api/digest', { method: 'POST', headers: { 'x-cron-secret': 'cron-secret-local' } }), env));
    const scheduledBody = await scheduled.json();
    assert.ok(scheduledBody.mvp);
    assert.equal(mock.messages.filter((m) => m.body.text.includes('نشرة ديل سيريا')).length, 0);
    assert.equal(sqlite.prepare("SELECT COUNT(*) n FROM digests WHERE subscriber_id=(SELECT id FROM subscribers WHERE email='active@example.test') AND status='mvp_sent'").get().n, 1);

    // New day: exactly one more delivery.
    sqlite.prepare("UPDATE subscribers SET last_digest_at=? WHERE email='active@example.test'").run(iso(-25 * 3600000));
    await tg(env, { message: { text: '/news', chat: { id: 444, type: 'private' }, from: { id: 444 } } });
    assert.equal(sqlite.prepare("SELECT COUNT(*) n FROM digests WHERE subscriber_id=(SELECT id FROM subscribers WHERE email='active@example.test') AND status='mvp_sent'").get().n, 2);
  } finally { mock.restore(); sqlite.close(); }
});

test('AC-11: /stop stops delivery and erases nothing', async () => {
  const { db, sqlite, env } = await makeEnv();
  const mock = mockTelegram();
  try {
    await subscribePending(env, 'stopper@example.test');
    await activateAndLink(sqlite, 'stopper@example.test', 666);
    await tg(env, { message: { text: '/stop', chat: { id: 666, type: 'private' }, from: { id: 666 } } });
    assert.equal(sqlite.prepare("SELECT paused FROM rss_telegram_prefs WHERE subscriber_id=(SELECT id FROM subscribers WHERE email='stopper@example.test')").get().paused, 1);
    const row = sqlite.prepare("SELECT status, telegram_chat_id FROM subscribers WHERE email='stopper@example.test'").get();
    assert.equal(row.status, 'active', 'account intact');
    assert.equal(row.telegram_chat_id, '666', 'link intact');
    mock.messages.length = 0;
    await tg(env, { message: { text: '/news', chat: { id: 666, type: 'private' }, from: { id: 666 } } });
    assert.ok(mock.messages.at(-1).body.text.includes('موقوف'));
    assert.equal(sqlite.prepare("SELECT COUNT(*) n FROM digests WHERE status='mvp_sent'").get().n, 0);
    await tg(env, { message: { text: '/status', chat: { id: 666, type: 'private' }, from: { id: 666 } } });
    assert.ok(mock.messages.at(-1).body.text.includes('مفعّل') && mock.messages.at(-1).body.text.includes('موقوف'));
  } finally { mock.restore(); sqlite.close(); }
});

// ——— scheduled MVP digest across subscriber states + empty news safety ———

test('AC-10b: scheduled MVP digest honours hour, pause, beta isolation and empty news', async () => {
  const { db, sqlite, env } = await makeEnv();
  const mock = mockTelegram();
  try {
    const hour = new Date(Date.now() + 3 * 3600000).getUTCHours();
    await subscribePending(env, 'due@example.test');
    const dueId = sqlite.prepare("SELECT id FROM subscribers WHERE email='due@example.test'").get().id;
    sqlite.prepare("UPDATE subscribers SET status='active', delivery_hour=?, telegram_chat_id='801' WHERE id=?").run(hour, dueId);

    await subscribePending(env, 'paused@example.test');
    const pausedId = sqlite.prepare("SELECT id FROM subscribers WHERE email='paused@example.test'").get().id;
    sqlite.prepare("UPDATE subscribers SET status='active', delivery_hour=?, telegram_chat_id='802' WHERE id=?").run(hour, pausedId);
    sqlite.prepare('INSERT INTO rss_telegram_prefs (subscriber_id,paused,updated_at) VALUES (?,1,?)').run(pausedId, iso(0));

    await subscribePending(env, 'beta@example.test');
    const betaId = sqlite.prepare("SELECT id FROM subscribers WHERE email='beta@example.test'").get().id;
    sqlite.prepare("UPDATE subscribers SET status='active', delivery_hour=?, telegram_chat_id='803' WHERE id=?").run(hour, betaId);
    sqlite.prepare('INSERT INTO beta_identities (chat_id, subscriber_id, created_at, created_beta) VALUES (?, ?, ?, 1)').run('803', betaId, iso(0));

    await subscribePending(env, 'late@example.test');
    const lateId = sqlite.prepare("SELECT id FROM subscribers WHERE email='late@example.test'").get().id;
    sqlite.prepare("UPDATE subscribers SET status='active', delivery_hour=?, telegram_chat_id='804' WHERE id=?").run((hour + 1) % 24, lateId);

    const res = await digestRoute.onRequestPost(ctx(new Request('https://dial.test/api/digest', { method: 'POST', headers: { 'x-cron-secret': 'cron-secret-local' } }), env));
    const body = await res.json();
    assert.equal(body.mvp.due, 1);
    assert.equal(body.mvp.sent, 1);
    assert.equal(mock.messages.filter((m) => m.body.text.includes('نشرة ديل سيريا')).length, 1);
    assert.equal(sqlite.prepare("SELECT COUNT(*) n FROM digests WHERE status='mvp_sent'").get().n, 1);
  } finally { mock.restore(); sqlite.close(); }
});

test('AC-10c: no digest is sent when stored news is empty', async () => {
  const { db, sqlite, env } = await makeEnv();
  const mock = mockTelegram();
  try {
    db.prepare('DELETE FROM articles').bind().run();
    await subscribePending(env, 'empty@example.test');
    await activateAndLink(sqlite, 'empty@example.test', 901);
    mock.messages.length = 0;
    await tg(env, { message: { text: '/news', chat: { id: 901, type: 'private' }, from: { id: 901 } } });
    assert.ok(mock.messages.at(-1).body.text.includes('لا توجد أخبار جديدة'));
    assert.equal(sqlite.prepare("SELECT COUNT(*) n FROM digests WHERE status='mvp_sent'").get().n, 0);
  } finally { mock.restore(); sqlite.close(); }
});
