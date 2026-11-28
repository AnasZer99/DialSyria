import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { DatabaseSync } from 'node:sqlite';
import { openDatabase as openIsolated, loadIngest, loadClassify, loadEmail, loadNewsRoute, loadDigest } from '../scripts/discovery-runtime.mjs';

const ingest = await loadIngest();
const classify = await loadClassify();
const LEGACY_SCHEMA = await readFile('schema.sql', 'utf8');

/** Isolated DB with the discovery migrations plus the legacy news/subscriber schema. */
async function openDatabase(name) {
  const opened = await openIsolated(name);
  opened.sqlite.exec(LEGACY_SCHEMA);
  return opened;
}

const DAY = 86400000;
const now = Date.now();
const iso = (offsetMs) => new Date(now + offsetMs).toISOString();

const esc = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const item = (title, link, date, desc = '') =>
  `<item><title>${esc(title)}</title><link>${link}</link>${date ? `<pubDate>${new Date(date).toUTCString()}</pubDate>` : ''}${desc ? `<description>${esc(desc)}</description>` : ''}</item>`;
const rss = (...items) => `<rss><channel>${items.join('')}</channel></rss>`;

const source = (id, url, extra = {}) => ({ id, name: 'مصدر ' + id, url, scope: 'syria', topic: 'politics', kind: 'publisher', enabled: true, ...extra });

const mapFetcher = (table) => async (input) => {
  const url = String(input);
  const handler = table[url];
  if (!handler) throw new Error('unexpected ' + url);
  if (handler instanceof Error) throw handler;
  return handler();
};
const okFeed = (xml) => () => new Response(xml, { status: 200 });

// ——— Parser ———

test('parseFeed reads beyond the legacy 12-item cap and honours an explicit cap', () => {
  const items = Array.from({ length: 20 }, (_, i) => item(`خبر عربي رقم ${i + 1} في سوريا`, `https://example.org/a${i}`));
  const xml = rss(...items);
  assert.equal(ingest.parseFeed(xml).length, 20);
  assert.equal(ingest.parseFeed(xml, 12).length, 12);
  const many = rss(...Array.from({ length: 150 }, (_, i) => item(`خبر عربي رقم ${i + 1} في سوريا`, `https://example.org/b${i}`)));
  assert.equal(ingest.parseFeed(many).length, 100);
});

test('parseFeed handles CDATA, entities and RDF-style item attributes', () => {
  const xml = `<rss><channel>
    <item rdf:about="https://example.org/x"><title><![CDATA[عنوان عربي طويل &amp; مهم]]></title><link>https://example.org/x</link><pubDate>Wed, 25 Nov 2026 10:00:00 GMT</pubDate></item>
  </channel></rss>`;
  const parsed = ingest.parseFeed(xml);
  assert.equal(parsed.length, 1);
  assert.equal(parsed[0].title, 'عنوان عربي طويل & مهم');
  assert.equal(parsed[0].link, 'https://example.org/x');
});

// ——— Classification ———

test('canonicalUrl strips tracking parameters and hashes and rejects unsafe schemes', () => {
  assert.equal(classify.canonicalUrl('https://example.org/a/?utm_source=x&fbclid=1#top'), 'https://example.org/a');
  assert.equal(classify.canonicalUrl('https://example.org/a'), 'https://example.org/a');
  assert.equal(classify.canonicalUrl('javascript:alert(1)'), null);
  assert.equal(classify.canonicalUrl('https://user:pass@example.org/a'), null);
});

test('every supported topic is classified from Arabic titles', () => {
  assert.equal(classify.classifyTopic('ارتفاع أسعار الليرة والدولار في الأسواق'), 'economy');
  assert.equal(classify.classifyTopic('شركة آبل تكشف عن شريحة جديدة'), 'tech');
  assert.equal(classify.classifyTopic('منتخب سوريا يخوض مباراة ودية'), 'sports');
  assert.equal(classify.classifyTopic('مستشفى جديد يفتتح قسم علاج الأورام'), 'health');
  assert.equal(classify.classifyTopic('مهرجان ثقافي ورواية جديدة في معرض الكتاب'), 'culture');
  assert.equal(classify.classifyTopic('وزير الخارجية يبحث اتفاق الهدنة'), 'politics');
  assert.equal(classify.classifyTopic('عنوان بلا كلمات مفتاحية'), null);
});

test('classification regressions from the live staging misclassifications', () => {
  // «الصين تؤكد...» — previously fell back to politics from a general feed.
  assert.equal(classify.classifyTopic('الصين تؤكد ضرورة اتخاذ تدابير جديدة لتعزيز استقرار سوق رأس المال'), 'economy');
  assert.equal(classify.detectScope('الصين تؤكد ضرورة اتخاذ تدابير جديدة لتعزيز استقرار سوق رأس المال', 'syria'), 'global');
  // «مجتمع الأعمال الصيني يدعو واشنطن...» — customs tariffs are economy.
  assert.equal(classify.classifyTopic('مجتمع الأعمال الصيني يدعو واشنطن لسحب الرسوم الجمركية المقترحة على بكين'), 'economy');
  assert.equal(classify.detectScope('مجتمع الأعمال الصيني يدعو واشنطن لسحب الرسوم الجمركية المقترحة على بكين', 'syria'), 'global');
  // «أربيل تتهم بغداد...» — foreign cities from a Syrian feed stay world news.
  assert.equal(classify.classifyTopic('أربيل تتهم بغداد بانتهاك ست مواد دستورية رئيسية'), 'politics');
  assert.equal(classify.detectScope('أربيل تتهم بغداد بانتهاك ست مواد دستورية رئيسية', 'syria'), 'global');
  // «تدمير صاروخ كروز...الرياض» — missile/militia is politics; Riyadh is foreign.
  assert.equal(classify.classifyTopic('تدمير صاروخ كروز أطلقته ميليشيا الحوثي باتجاه الرياض'), 'politics');
  assert.equal(classify.detectScope('تدمير صاروخ كروز أطلقته ميليشيا الحوثي باتجاه الرياض', 'syria'), 'global');
  // Education and odd-interest stories are NOT politics by default: excluded.
  assert.equal(classify.classifyTopic('وزارة التربية والتعليم تحدد ضوابط تنظيم الشعب الصفية'), null);
  assert.equal(classify.classifyTopic('صيد استثنائي في نيويورك.. سمكة بوربوت نادرة'), null);
  assert.equal(classify.detectScope('صيد استثنائي في نيويورك.. سمكة بوربوت نادرة', 'syria'), 'global');
  assert.equal(classify.classifyTopic('عاصفة قوية تخلف فيضانات وانقطاعًا واسعًا للكهرباء في أمريكا'), null);
  assert.equal(classify.detectScope('عاصفة قوية تخلف فيضانات وانقطاعًا واسعًا للكهرباء في أمريكا', 'syria'), 'global');
  // Syrian sports event stays local.
  assert.equal(classify.classifyTopic('غداً.. ختام بطولة النصر الدولية لفروسية قفز الحواجز في ريف دمشق'), 'sports');
  assert.equal(classify.detectScope('غداً.. ختام بطولة النصر الدولية لفروسية قفز الحواجز في ريف دمشق', 'global'), 'syria');
  // Word-boundary guards: partial matches must not misfire.
  assert.equal(classify.detectScope('البابا يلتقي وفداً في الفاتيكان', 'syria'), 'global'); // البابا ≠ مدينة الباب
  assert.equal(classify.detectScope('حفل رياضي في الرياض', 'syria'), 'global'); // الرياض ≠ صفة «الرياضي»
});

test('clear six-category stories are never excluded for keyword gaps', () => {
  const mustClassify = [
    ['اجتماع طارئ لمجلس الوزراء لبحث الأوضاع العامة', 'politics'],
    ['مظاهرات احتجاجية في مدينة حلب تطالب بإصلاحات', 'politics'],
    ['إقرار ميزانية جديدة للدولة ورفع الرواتب', 'economy'],
    ['ارتفاع أسعار الوقود والمحروقات هذا الشهر', 'economy'],
    ['تحديث تطبيق الدفع الإلكتروني لسداد الفواتير', 'tech'],
    ['انطلاق سباق الدراجات في مدينة حمص', 'sports'],
    ['منتخب سوريا يواجه نظيره الليبي في مباراة ودية', 'sports'],
    ['حملة تلقيح ضد الإنفلونزا في المدارس', 'health'],
    ['افتتاح جناح جديد في مستشفى حماة', 'health'],
    ['فيلم وثائقي جديد يوثق تراث دير الزور', 'culture'],
    ['افتتاح معرض الكتاب في ساحة جامعة دمشق', 'culture'],
  ];
  for (const [title, expected] of mustClassify) {
    assert.equal(classify.classifyTopic(title), expected, title);
  }
  // Scopes for the same set: Syrian geography stays local, foreign stays global.
  assert.equal(classify.detectScope('مظاهرات احتجاجية في مدينة حلب تطالب بإصلاحات', 'global'), 'syria');
  assert.equal(classify.detectScope('منتخب سوريا يواجه نظيره الليبي في مباراة ودية', 'global'), 'syria');
  assert.equal(classify.detectScope('فيلم وثائقي جديد يوثق تراث دير الزور', 'global'), 'syria');
});

test('Syrian stories mentioning foreign countries keep the syria scope', () => {
  assert.equal(classify.detectScope('سوريا وتركيا توقعان اتفاقاً تجارياً جديداً', 'syria'), 'syria');
  assert.equal(classify.classifyTopic('سوريا وتركيا توقعان اتفاقاً تجارياً جديداً'), 'economy');
  assert.equal(classify.detectScope('وزير الخارجية السوري يلتقي نظيره التركي في دمشق', 'global'), 'syria');
  assert.equal(classify.detectScope('الجيش السوري ينشر مركزاً عسكرياً جديداً في حلب', 'global'), 'syria');
  assert.equal(classify.classifyTopic('الجيش السوري ينشر مركزاً عسكرياً جديداً في حلب'), 'politics');
});

test('scope rules: Syrian city, Syria word, foreign-only and fallback', () => {
  assert.equal(classify.detectScope('إدلب: مشروع تزفيت طرق', 'global'), 'syria');
  assert.equal(classify.detectScope('سوريا وتركيا تبحثان اتفاقاً جديداً', 'syria'), 'syria');
  assert.equal(classify.detectScope('انتخابات في فرنسا', 'syria'), 'global');
  assert.equal(classify.detectScope('افتتاح معرض محلي', 'syria'), 'syria');
  assert.equal(classify.detectScope('افتتاح معرض محلي', 'global'), 'global');
});

// ——— Ingestion ———

test('ingestion stores fresh Arabic items, skips old and foreign-language items, deduplicates URLs and keeps dateless items', async () => {
  const { db, sqlite } = await openDatabase(':memory:');
  const fetcher = mapFetcher({
    'https://a.example/feed/': okFeed(rss(
      item('مشروع مياه حكومي جديد في إدلب', 'https://publisher.example/water?utm_source=rss', iso(-3600000), 'تفاصيل كافية عن مشروع مياه حكومي جديد في محافظة إدلب يخدم عدة بلدات ويبدأ العمل فيه هذا الشهر.'),
      item('Breaking news in English only', 'https://publisher.example/en', iso(-3600000)),
      item('خبر قديم في حلب', 'https://publisher.example/old', iso(-20 * DAY)),
      item('خبر بلا تاريخ نشر في حمص عن مستشفى جديد', 'https://publisher.example/nodate'),
    )),
    'https://b.example/feed/': okFeed(rss(
      item('نفس مشروع المياه الحكومي في إدلب من مصدر ثانٍ', 'https://publisher.example/water', iso(-3600000)),
      item('افتتاح مركز صحي في دمشق', 'https://publisher.example/clinic', iso(-7200000)),
    )),
  });
  try {
    const result = await ingest.runIngestion({ DB: db }, { fetcher, sources: [source('a', 'https://a.example/feed/'), source('b', 'https://b.example/feed/', { scope: 'global' })] });
    assert.equal(result.ok, true);
    assert.equal(result.feeds_ok, 2);
    assert.equal(result.feeds_fail, 0);
    const rows = sqlite.prepare('SELECT title, url, published_at, scope, topic, summary FROM articles ORDER BY title').all();
    assert.equal(rows.length, 3);
    assert.ok(rows.some((r) => r.url === 'https://publisher.example/water'));
    assert.ok(!rows.some((r) => r.url.includes('utm_source')));
    assert.ok(rows.some((r) => r.published_at === null));
    assert.ok(rows.some((r) => r.summary && r.summary.includes('مشروع مياه')));
    const water = rows.find((r) => r.url === 'https://publisher.example/water');
    assert.equal(water.scope, 'syria');
    assert.equal(water.topic, 'politics');
  } finally { sqlite.close(); }
});

test('titles without a confident topic are excluded and counted, not defaulted to politics', async () => {
  const { db, sqlite } = await openDatabase(':memory:');
  const fetcher = mapFetcher({
    'https://mix.example/feed/': okFeed(rss(
      item('وزارة التربية والتعليم تحدد ضوابط تنظيم الشعب الصفية', 'https://mix.example/1', iso(-3600000)),
      item('صيد استثنائي في نيويورك.. سمكة بوربوت نادرة', 'https://mix.example/2', iso(-3600000)),
      item('عاصفة قوية تخلف فيضانات وانقطاعًا للكهرباء في أمريكا', 'https://mix.example/3', iso(-3600000)),
      item('خبر سياسي محدد في إدلب', 'https://mix.example/4', iso(-3600000)),
    )),
  });
  try {
    const result = await ingest.runIngestion({ DB: db }, { fetcher, sources: [source('mix', 'https://mix.example/feed/')] });
    assert.equal(result.feeds_ok, 1);
    assert.equal(result.feeds_fail, 0);
    assert.equal(result.inserted, 1);
    assert.equal(result.sources[0].parsed, 4);
    assert.equal(result.sources[0].recent, 1);
    assert.equal(result.sources[0].unclassified, 3);
    assert.equal(sqlite.prepare('SELECT count(*) n FROM articles').get().n, 1);
    assert.equal(sqlite.prepare("SELECT topic, scope FROM articles WHERE url='https://mix.example/4'").get().topic, 'politics');
    // The exclusion count is persisted in the idempotent companion table (0015).
    assert.equal(
      sqlite.prepare("SELECT unclassified FROM ingestion_source_skips WHERE source_id='mix'").get().unclassified,
      3,
    );
  } finally { sqlite.close(); }
});

test('one failing source never blocks the others; 404, timeout and broken XML are recorded', async () => {
  const { db, sqlite } = await openDatabase(':memory:');
  const fetcher = mapFetcher({
    'https://ok.example/feed/': okFeed(rss(item('خبر سياسي محلي جديد في إدلب', 'https://ok.example/1', iso(-3600000)))),
    'https://missing.example/feed/': () => new Response('', { status: 404 }),
    'https://slow.example/feed/': new Error('The operation timed out'),
    'https://broken.example/feed/': okFeed('<html><body>not rss</body></html>'),
  });
  try {
    const result = await ingest.runIngestion({ DB: db }, {
      fetcher,
      sources: [
        source('ok', 'https://ok.example/feed/'),
        source('missing', 'https://missing.example/feed/'),
        source('slow', 'https://slow.example/feed/'),
        source('broken', 'https://broken.example/feed/'),
      ],
    });
    assert.equal(result.feeds_ok, 1);
    assert.equal(result.feeds_fail, 3);
    assert.equal(result.sources.length, 4);
    assert.equal(result.sources.find((s) => s.id === 'missing').status, 'http_error');
    assert.equal(result.sources.find((s) => s.id === 'slow').status, 'timeout');
    assert.equal(result.sources.find((s) => s.id === 'broken').status, 'empty');
    assert.equal(sqlite.prepare('SELECT count(*) n FROM articles').get().n, 1);
    const runRow = sqlite.prepare('SELECT feeds_ok, feeds_fail, inserted FROM ingestion_runs').get();
    assert.equal(runRow.feeds_ok, 1);
    assert.equal(runRow.feeds_fail, 3);
    assert.equal(runRow.inserted, 1);
  } finally { sqlite.close(); }
});

test('a busy feed with more than 12 items keeps every fresh item', async () => {
  const { db, sqlite } = await openDatabase(':memory:');
  const items = Array.from({ length: 20 }, (_, i) => item(`خبر سياسي عربي رقم ${i + 1} في إدلب`, `https://busy.example/${i}`, iso(-i * 60000)));
  const fetcher = mapFetcher({ 'https://busy.example/feed/': okFeed(rss(...items)) });
  try {
    const result = await ingest.runIngestion({ DB: db }, { fetcher, sources: [source('busy', 'https://busy.example/feed/')] });
    assert.equal(result.inserted, 20);
    assert.equal(sqlite.prepare('SELECT count(*) n FROM articles').get().n, 20);
  } finally { sqlite.close(); }
});

test('a second run on the same Damascus day is a no-op; a forced rerun cannot duplicate rows', async () => {
  const { db, sqlite } = await openDatabase(':memory:');
  const fetcher = mapFetcher({ 'https://once.example/feed/': okFeed(rss(item('خبر سياسي يومي جديد في إدلب', 'https://once.example/1', iso(-3600000)))) });
  try {
    const first = await ingest.runIngestion({ DB: db }, { fetcher, sources: [source('once', 'https://once.example/feed/')] });
    assert.equal(first.skipped, undefined);
    assert.equal(first.inserted, 1);
    const second = await ingest.runIngestion({ DB: db }, { fetcher, sources: [source('once', 'https://once.example/feed/')] });
    assert.equal(second.skipped, 'already_ran_today');
    assert.equal(second.inserted, 0);
    const forced = await ingest.runIngestion({ DB: db }, { force: true, fetcher, sources: [source('once', 'https://once.example/feed/')] });
    assert.equal(forced.inserted, 0);
    assert.equal(sqlite.prepare('SELECT count(*) n FROM articles').get().n, 1);
    assert.equal(sqlite.prepare('SELECT count(*) n FROM ingestion_runs').get().n, 2);
  } finally { sqlite.close(); }
});

// ——— News API ———

test('news API filters by scope and topic, paginates, and survives a late cron', async () => {
  globalThis.caches = { default: { match: async () => undefined, put: async () => {} } };
  const news = await loadNewsRoute();
  const { db, sqlite } = await openDatabase(':memory:');
  const insert = sqlite.prepare('INSERT INTO articles (id,title,summary,url,source,topic,scope,published_at,fetched_at) VALUES (?,?,?,?,?,?,?,?,?)');
  insert.run('1', 'خبر سياسي سوري الأول', null, 'https://n.example/1', 'سانا', 'politics', 'syria', iso(-1 * 3600000), iso(-1 * 3600000));
  insert.run('2', 'خبر سوري ثانٍ', null, 'https://n.example/2', 'سانا', 'politics', 'syria', iso(-2 * 3600000), iso(-2 * 3600000));
  insert.run('3', 'خبر تقني عالمي', null, 'https://n.example/3', 'BBC', 'tech', 'global', iso(-3 * 3600000), iso(-3 * 3600000));
  insert.run('4', 'خبر قديم مستبعد', null, 'https://n.example/4', 'سانا', 'politics', 'syria', iso(-9 * DAY), iso(-9 * DAY));
  // Late cron: fetched three days ago, published two days ago → still inside the 7-day public window.
  insert.run('5', 'خبر متأخر الجمع', null, 'https://n.example/5', 'سانا', 'politics', 'syria', iso(-2 * DAY), iso(-3 * DAY));
  try {
    const call = async (qs) => {
      const res = await news.onRequestGet({ request: new Request('https://dial.test/api/news' + qs), env: { DB: db }, params: {}, waitUntil() {} });
      return { status: res.status, body: await res.json() };
    };
    const all = await call('');
    assert.equal(all.status, 200);
    assert.ok(all.body.articles.length >= 4);
    assert.ok(!all.body.articles.some((a) => a.url === 'https://n.example/4'));
    assert.ok(all.body.articles.some((a) => a.url === 'https://n.example/5'));

    const syria = await call('?scope=syria&limit=2');
    assert.equal(syria.body.articles.length, 2);
    assert.ok(syria.body.articles.every((a) => a.scope === 'syria'));
    assert.equal(syria.body.has_more, true);
    const page2 = await call('?scope=syria&limit=2&page=2');
    assert.ok(page2.body.articles.length >= 1);

    const tech = await call('?topic=tech');
    assert.equal(tech.body.articles.length, 1);
    assert.equal(tech.body.articles[0].topic, 'tech');

    assert.equal((await call('?scope=mars')).status, 400);
    assert.equal((await call('?topic=weather')).status, 400);
    assert.equal((await call('?page=0')).status, 400);
    assert.equal((await call('?limit=500')).status, 400);
  } finally { sqlite.close(); }
});

// ——— Email provider ———

test('email provider selection prefers mock, then Resend, then Brevo', async () => {
  const email = await loadEmail();
  assert.equal(email.emailProvider({}), 'none');
  assert.equal(email.emailProvider({ BREVO_API_KEY: 'b', SENDER_EMAIL: 's@example.test' }), 'brevo');
  assert.equal(email.emailProvider({ RESEND_API_KEY: 'r', EMAIL_FROM: 'f@example.test' }), 'resend');
  assert.equal(email.emailProvider({ RESEND_API_KEY: 'r', EMAIL_FROM: 'f@example.test', EMAIL_MOCK: '1' }), 'mock');
  const mock = await email.sendEmailMessage({ EMAIL_MOCK: '1' }, { to: 'a@example.test', subject: 's', html: '<p>x</p>' });
  assert.equal(mock.ok, true);
  assert.equal(mock.provider, 'mock');
});

test('Resend delivery reports success and failure without exposing the key', async () => {
  const email = await loadEmail();
  const env = { RESEND_API_KEY: 'secret-key-123', EMAIL_FROM: 'news@example.test' };
  let seen = null;
  const ok = await email.sendEmailMessage(env, { to: 'u@example.test', subject: 'يومي', html: '<p>خبر</p>' }, async (url, init) => {
    seen = { url: String(url), auth: init.headers.authorization, body: JSON.parse(init.body) };
    return new Response(JSON.stringify({ id: 'msg_1' }), { status: 200 });
  });
  assert.equal(ok.ok, true);
  assert.equal(seen.url, 'https://api.resend.com/emails');
  assert.equal(seen.auth, 'Bearer secret-key-123');
  assert.deepEqual(seen.body.to, ['u@example.test']);
  assert.equal(seen.body.from, 'news@example.test');

  const fail = await email.sendEmailMessage(env, { to: 'u@example.test', subject: 's', html: '<p>x</p>' }, async () => new Response('{}', { status: 422 }));
  assert.equal(fail.ok, false);
  assert.equal(fail.status, 422);
  assert.ok(!String(fail.error).includes('secret-key-123'));
});

// ——— Daily digest with the mock transport ———

test('daily email digest sends once per day through the mock provider and stays empty-safe', async () => {
  const digest = await loadDigest();
  const { db, sqlite } = await openDatabase(':memory:');
  const hour = new Date(Date.now() + 3 * 3600000).getUTCHours();
  sqlite.prepare('INSERT INTO subscribers (id,email,status,language,delivery_hour,created_at) VALUES (?,?,?,?,?,?)')
    .run('sub-1', 'reader@example.test', 'active', 'ar', hour, iso(0));
  sqlite.prepare('INSERT INTO subscriber_topics (subscriber_id,topic) VALUES (?,?)').run('sub-1', 'politics');
  sqlite.prepare('INSERT INTO articles (id,title,summary,url,source,topic,scope,published_at,fetched_at) VALUES (?,?,?,?,?,?,?,?,?)')
    .run('a1', 'خبر سوري حديث', null, 'https://n.example/a1', 'سانا', 'politics', 'syria', iso(-3600000), iso(-3600000));
  try {
    const first = await digest.runDigest({ DB: db, EMAIL_MOCK: '1', SITE_URL: 'https://dial.test' });
    assert.equal(first.sent, 1);
    assert.equal(sqlite.prepare("SELECT status FROM digests WHERE subscriber_id='sub-1'").get().status, 'sent');
    assert.ok(sqlite.prepare("SELECT last_digest_at FROM subscribers WHERE id='sub-1'").get().last_digest_at);

    const second = await digest.runDigest({ DB: db, EMAIL_MOCK: '1', SITE_URL: 'https://dial.test' });
    assert.equal(second.due, 0);
    assert.equal(second.sent, 0);
  } finally { sqlite.close(); }

  const { db: db2, sqlite: sqlite2 } = await openDatabase(':memory:');
  const hour2 = new Date(Date.now() + 3 * 3600000).getUTCHours();
  sqlite2.prepare('INSERT INTO subscribers (id,email,status,language,delivery_hour,created_at) VALUES (?,?,?,?,?,?)')
    .run('sub-2', 'reader2@example.test', 'active', 'ar', hour2, iso(0));
  sqlite2.prepare('INSERT INTO subscriber_topics (subscriber_id,topic) VALUES (?,?)').run('sub-2', 'politics');
  try {
    // No provider configured and no articles: nothing is sent and nothing is marked sent.
    const none = await digest.runDigest({ DB: db2, SITE_URL: 'https://dial.test' });
    assert.equal(none.sent, 0);
    assert.equal(none.skipped_no_articles, 1);
    assert.equal(sqlite2.prepare("SELECT count(*) n FROM digests WHERE status='sent'").get().n, 0);
    assert.equal(sqlite2.prepare("SELECT status FROM digests WHERE subscriber_id='sub-2'").get().status, 'no_new_articles');
  } finally { sqlite2.close(); }
});

test('beta Telegram delivery stays disabled by default while the digest is independent', async () => {
  const digest = await loadDigest();
  const { db, sqlite } = await openDatabase(':memory:');
  const hour = new Date(Date.now() + 3 * 3600000).getUTCHours();
  sqlite.prepare('INSERT INTO subscribers (id,email,status,language,delivery_hour,created_at) VALUES (?,?,?,?,?,?)')
    .run('sub-3', 'reader3@example.test', 'active', 'ar', hour, iso(0));
  sqlite.prepare('INSERT INTO subscriber_topics (subscriber_id,topic) VALUES (?,?)').run('sub-3', 'politics');
  sqlite.prepare('INSERT INTO articles (id,title,summary,url,source,topic,scope,published_at,fetched_at) VALUES (?,?,?,?,?,?,?,?,?)')
    .run('a3', 'خبر سوري ثالث', null, 'https://n.example/a3', 'سانا', 'politics', 'syria', iso(-3600000), iso(-3600000));
  try {
    const result = await digest.runDigest({ DB: db, EMAIL_MOCK: '1', SITE_URL: 'https://dial.test' });
    assert.equal(result.sent, 1);
    assert.equal(sqlite.prepare("SELECT count(*) n FROM notifications").get().n, 0);
  } finally { sqlite.close(); }
});

// ——— Daily-run operational scenarios ———

test('a feed with more than 100 items stores the first 100 without loss or duplication', async () => {
  const { db, sqlite } = await openDatabase(':memory:');
  const items = Array.from({ length: 150 }, (_, i) => item(`خبر سياسي يومي رقم ${i + 1} في سوريا`, `https://big.example/${i}`, iso(-i * 60000)));
  const fetcher = mapFetcher({ 'https://big.example/feed/': okFeed(rss(...items)) });
  try {
    const result = await ingest.runIngestion({ DB: db }, { fetcher, sources: [source('big', 'https://big.example/feed/')] });
    assert.equal(result.sources[0].parsed, 100);
    assert.equal(result.inserted, 100);
    assert.equal(sqlite.prepare('SELECT count(*) n FROM articles').get().n, 100);
  } finally { sqlite.close(); }
});

test('a high-volume source with a raised per-feed cap stores the whole feed window', async () => {
  const { db, sqlite } = await openDatabase(':memory:');
  const items = Array.from({ length: 150 }, (_, i) => item(`خبر سياسي يومي رقم ${i + 1} في سوريا`, `https://sana-like.example/${i}`, iso(-i * 60000)));
  const fetcher = mapFetcher({ 'https://sana-like.example/feed/': okFeed(rss(...items)) });
  try {
    const result = await ingest.runIngestion({ DB: db }, {
      fetcher,
      sources: [source('sana-like', 'https://sana-like.example/feed/', { maxItems: 200 })],
    });
    assert.equal(result.sources[0].parsed, 150);
    assert.equal(result.inserted, 150);
    assert.equal(sqlite.prepare('SELECT count(*) n FROM articles').get().n, 150);
  } finally { sqlite.close(); }
});

test('a feed with no items in the last 24 hours still succeeds and stores the 72-hour window', async () => {
  const { db, sqlite } = await openDatabase(':memory:');
  const fetcher = mapFetcher({
    'https://quiet.example/feed/': okFeed(rss(
      item('خبر سياسي عمره ثلاثون ساعة في إدلب', 'https://quiet.example/30h', iso(-30 * 3600000)),
      item('خبر سياسي عمره خمسون ساعة في حلب', 'https://quiet.example/50h', iso(-50 * 3600000)),
    )),
    'https://stale.example/feed/': okFeed(rss(
      item('خبر قديم جدا في حمص', 'https://stale.example/5d', iso(-5 * DAY)),
    )),
  });
  try {
    const result = await ingest.runIngestion({ DB: db }, {
      fetcher,
      sources: [source('quiet', 'https://quiet.example/feed/'), source('stale', 'https://stale.example/feed/')],
    });
    assert.equal(result.feeds_ok, 2);
    assert.equal(result.feeds_fail, 0);
    assert.equal(result.inserted, 2);
    assert.equal(result.sources.find((s) => s.id === 'quiet').recent, 2);
    assert.equal(result.sources.find((s) => s.id === 'stale').recent, 0);
    assert.equal(sqlite.prepare('SELECT count(*) n FROM articles').get().n, 2);
  } finally { sqlite.close(); }
});

test('a partial run can be retried the same day and a clean run then blocks further runs', async () => {
  const { db, sqlite } = await openDatabase(':memory:');
  let health = { a: 200, b: 500 };
  const fetcher = async (input) => {
    const url = String(input);
    if (url === 'https://a.example/feed/') return new Response(rss(item('خبر سياسي من المصدر أ في إدلب', 'https://a.example/1', iso(-3600000))), { status: health.a });
    if (url === 'https://b.example/feed/') return new Response(rss(item('خبر سياسي من المصدر ب في حلب', 'https://b.example/1', iso(-3600000))), { status: health.b });
    throw new Error('unexpected ' + url);
  };
  try {
    const first = await ingest.runIngestion({ DB: db }, { fetcher, sources: [source('a', 'https://a.example/feed/'), source('b', 'https://b.example/feed/')] });
    assert.equal(first.feeds_ok, 1);
    assert.equal(first.feeds_fail, 1);
    assert.equal(first.inserted, 1);
    assert.equal(sqlite.prepare('SELECT feeds_fail FROM ingestion_runs').get().feeds_fail, 1);

    health = { a: 200, b: 200 };
    const retry = await ingest.runIngestion({ DB: db }, { fetcher, sources: [source('a', 'https://a.example/feed/'), source('b', 'https://b.example/feed/')] });
    assert.equal(retry.skipped, undefined, 'a partial run must allow a same-day retry');
    assert.equal(retry.inserted, 1, 'the retry inserts only the missing item');
    assert.equal(sqlite.prepare('SELECT count(*) n FROM articles').get().n, 2);
    assert.equal(sqlite.prepare('SELECT count(*) n FROM ingestion_runs').get().n, 2);

    const third = await ingest.runIngestion({ DB: db }, { fetcher, sources: [source('a', 'https://a.example/feed/'), source('b', 'https://b.example/feed/')] });
    assert.equal(third.skipped, 'already_ran_today');
    assert.equal(sqlite.prepare('SELECT count(*) n FROM articles').get().n, 2);
  } finally { sqlite.close(); }
});

test('no digest email is sent while the provider is not configured', async () => {
  const digest = await loadDigest();
  const { db, sqlite } = await openDatabase(':memory:');
  const hour = new Date(Date.now() + 3 * 3600000).getUTCHours();
  sqlite.prepare('INSERT INTO subscribers (id,email,status,language,delivery_hour,created_at) VALUES (?,?,?,?,?,?)')
    .run('sub-4', 'reader4@example.test', 'active', 'ar', hour, iso(0));
  sqlite.prepare('INSERT INTO subscriber_topics (subscriber_id,topic) VALUES (?,?)').run('sub-4', 'politics');
  sqlite.prepare('INSERT INTO articles (id,title,summary,url,source,topic,scope,published_at,fetched_at) VALUES (?,?,?,?,?,?,?,?,?)')
    .run('a4', 'خبر سوري رابع', null, 'https://n.example/a4', 'سانا', 'politics', 'syria', iso(-3600000), iso(-3600000));
  try {
    const none = await digest.runDigest({ DB: db, SITE_URL: 'https://dial.test' });
    assert.equal(none.due, 1);
    assert.equal(none.sent, 0);
    assert.equal(none.skipped_no_provider, 1);
    assert.equal(sqlite.prepare("SELECT status FROM digests WHERE subscriber_id='sub-4'").get().status, 'no_provider');
    assert.equal(sqlite.prepare("SELECT last_digest_at FROM subscribers WHERE id='sub-4'").get().last_digest_at, null);
  } finally { sqlite.close(); }
});

test('a fresh database can be created from schema.sql and migrations 0014/0015 apply idempotently', async () => {
  const migration = await readFile('migrations/0014_ingestion_sources.sql', 'utf8');
  const migration15 = await readFile('migrations/0015_ingestion_unclassified.sql', 'utf8');
  const db = new DatabaseSync(':memory:');
  try {
    db.exec(LEGACY_SCHEMA);
    db.exec(migration);
    db.exec(migration); // re-applying the additive migration must be a no-op
    db.exec(migration15);
    db.exec(migration15); // 0015 is CREATE IF NOT EXISTS: safe on every path
    const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all().map((r) => r.name);
    for (const t of ['subscribers', 'subscriber_topics', 'articles', 'ingestion_runs', 'rate_limits', 'digests', 'ingestion_sources', 'ingestion_source_skips']) {
      assert.ok(tables.includes(t), 'missing table ' + t);
    }
    const indexes = db.prepare("SELECT name FROM sqlite_master WHERE type='index'").all().map((r) => r.name);
    for (const i of ['idx_ingestion_sources_run', 'idx_articles_scope_topic', 'idx_articles_fetched', 'idx_ingestion_source_skips_run']) {
      assert.ok(indexes.includes(i), 'missing index ' + i);
    }
    const cols = db.prepare('PRAGMA table_info(ingestion_source_skips)').all().map((c) => c.name);
    for (const c of ['run_started_at', 'source_id', 'source_name', 'unclassified']) {
      assert.ok(cols.includes(c), 'missing column ' + c);
    }
  } finally { db.close(); }
});
