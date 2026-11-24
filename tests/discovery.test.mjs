import { test } from 'node:test';
import assert from 'node:assert/strict';
import { loadEngine, openDatabase } from '../scripts/discovery-runtime.mjs';
const engine = await loadEngine();

test('query generation and location-aware relevance', () => {
  assert.ok(engine.generateQueries('قرارات البناء والتراخيص في إدلب').some(x => x.includes('إدلب')));
  const item = {title:'قرار تراخيص البناء في إدلب',description:'تنظيم عمراني',url:'https://example.org/a',source:'مثال',publishedAt:null,provider:'mock'};
  assert.equal(engine.evaluate('قرارات البناء والتراخيص في إدلب',item).accepted,true);
  assert.equal(engine.evaluate('قرارات البناء والتراخيص في حلب',item).accepted,false);
  assert.equal(engine.evaluate('قرارات البناء والتراخيص في إدلب',{...item,title:'تنظيم البناء في معرة النعمان'}).accepted,true);
  const flight = {...item,title:'رحلات من دمشق إلى القاهرة',description:'الخطوط الجوية السورية'};
  assert.equal(engine.evaluate('الرحلات الجوية الداخلية بين دمشق وحلب',flight).accepted,false);
  const radiology = {...item,title:'انطلاق فعاليات المؤتمر السوري للأشعة 2026 في المشفى الجامعي بدمشق',description:'',url:'https://example.org/radiology'};
  assert.equal(engine.evaluate('المؤتمرات الطبية للتصوير الشعاعي في دمشق',radiology).accepted,true);
});

test('test domains never enter live discovery queries', () => {
  const queries = engine.generateQueries('قرارات البناء والتراخيص في إدلب', ['mock-source.test', 'example.org']);
  assert.ok(!queries.some((q) => q.includes('mock-source.test')));
  assert.ok(queries.some((q) => q.includes('site:example.org')));
});

test('RSS parser, storage, source monitoring and repeated runs', async () => {
  const { db, sqlite } = await openDatabase(':memory:');
  const interest = 'قرارات البناء والتراخيص في إدلب';
  const xml = '<rss><channel><item><title>قرار تراخيص البناء في إدلب</title><link>https://example.org/story?utm_source=x</link><source>مصدر اختبار</source></item></channel></rss>';
  const fetcher = async () => new Response(xml,{status:200});
  try {
    const first = await engine.runDiscovery(db,interest,{fetcher});
    const second = await engine.runDiscovery(db,interest,{fetcher});
    assert.ok(first.decisions.some(x=>x.accepted));
    assert.ok(second.duplicates > 0);
    assert.equal(sqlite.prepare('SELECT count(*) n FROM discovery_items').get().n,1);
    assert.equal(sqlite.prepare('SELECT count(*) n FROM discovery_sources').get().n,1);
    assert.ok(second.queries.some(x=>x.includes('site:example.org')));
    assert.equal(sqlite.prepare('SELECT count(*) n FROM discovery_runs').get().n,2);
  } finally { sqlite.close(); }
});

test('Brave search and RSS fallback after provider errors', async () => {
  const brave = await engine.search('بناء إدلب','test-key',async (url, options) => {
    assert.ok(String(url).startsWith('https://api.search.brave.com/'));
    assert.equal(options.headers['X-Subscription-Token'],'test-key');
    return Response.json({web:{results:[{title:'البناء في إدلب',url:'https://example.org/a',description:'تراخيص'}]}});
  });
  assert.equal(brave.provider,'brave');
  assert.equal(brave.items[0].publishedAt,null);
  let calls = 0;
  const fallback = await engine.search('بناء إدلب','test-key',async url => {
    calls++;
    if (String(url).includes('api.search.brave.com')) return new Response('',{status:503});
    return new Response('<rss><item><title>تراخيص البناء في إدلب</title><link>https://example.org/b</link></item></rss>');
  });
  assert.equal(calls,3);
  assert.equal(fallback.provider,'google-news-rss');
  assert.equal(fallback.items.length,1);
  assert.match(fallback.warning,/Brave failed/);
});

test('publisher resolution checks redirects, robots and metadata', async () => {
  const google = 'https://news.google.com/rss/articles/id';
  const fetcher = async url => {
    if (url === google) return new Response(null,{status:302,headers:{location:'https://example.org/news/1'}});
    if (url === 'https://example.org/robots.txt') return new Response('User-agent: *\nDisallow: /private\nAllow: /news');
    if (url === 'https://example.org/news/1') return new Response('<meta property="og:title" content="عنوان الناشر"><meta property="article:published_time" content="2026-11-18T12:00:00+03:00">',{headers:{'content-type':'text/html'}});
    throw new Error('unexpected fetch');
  };
  const p = await engine.inspectPublisher(google,'https://example.org',fetcher);
  assert.equal(p.googleNewsUrl,google);
  assert.equal(p.originalUrl,'https://example.org/news/1');
  assert.equal(p.resolutionStatus,'http_redirect');
  assert.equal(p.publisherTitle,'عنوان الناشر');
  assert.equal(p.publisherPublishedAt,'2026-11-18T09:00:00.000Z');
  const mismatch = await engine.inspectPublisher(google,'https://other.example',fetcher);
  assert.equal(mismatch.originalUrl,null);
  assert.equal(mismatch.resolutionStatus,'redirect_source_mismatch');
  const interstitial = await engine.inspectPublisher(google,'https://example.org',async () => new Response('<html></html>'));
  assert.equal(interstitial.originalUrl,null);
  assert.equal(interstitial.resolutionStatus,'google_interstitial');
  const denied = await engine.inspectPublisher('https://example.org/private/a',undefined,async () => new Response('User-agent: *\nDisallow: /private'));
  assert.equal(denied.verificationStatus,'robots_denied_or_unavailable');
  assert.equal((await engine.inspectPublisher('http://127.0.0.1/admin',undefined,fetcher)).resolutionStatus,'invalid_url');
  const decision=engine.evaluate('قرارات البناء في إدلب',{title:'قرار تراخيص البناء في إدلب',description:'',url:google,source:'',publishedAt:'2026-11-10T00:00:00Z',provider:'mock'});
  Object.assign(decision,p); engine.comparePublisher(decision);
  assert.equal(decision.publisherTitleMatch,false);
  assert.ok(decision.publisherDateDifferenceHours > 48);
  assert.match(decision.verificationStatus,/title_mismatch.*date_mismatch/);
  const jsonLd = await engine.inspectPublisher('https://example.org/news/2',undefined,async url => String(url).endsWith('/robots.txt') ? new Response('',{status:404}) : new Response('<script type="application/ld+json">{"@type":"NewsArticle","headline":"عنوان آخر","datePublished":"2026-11-20T08:00:00Z"}</script>',{headers:{'content-type':'text/html'}}));
  assert.equal(jsonLd.publisherTitle,'عنوان آخر');
  assert.equal(jsonLd.publisherPublishedAt,'2026-11-20T08:00:00.000Z');
});

test('failed later resolution preserves verified publisher data in storage', async () => {
  const {db,sqlite}=await openDatabase(':memory:'); let follow=true;
  const item='<rss><item><title>قرار البناء في إدلب</title><link>https://news.google.com/rss/articles/a</link><source url="https://example.org">مصدر</source></item></rss>';
  const fetcher=async url => {
    const u=String(url);
    if(u.includes('/rss/search?')) return new Response(item);
    if(u.includes('news.google.com')) return follow ? new Response(null,{status:302,headers:{location:'https://example.org/news/1'}}) : new Response('interstitial');
    if(u.endsWith('/robots.txt')) return new Response('',{status:404});
    return new Response('<meta property="og:title" content="قرار البناء في إدلب">',{headers:{'content-type':'text/html'}});
  };
  try {
    await engine.runDiscovery(db,'قرار البناء في إدلب',{fetcher}); follow=false;
    await engine.runDiscovery(db,'قرار البناء في إدلب',{fetcher});
    const row=sqlite.prepare('SELECT original_url, google_news_url, publisher_title FROM discovery_items').get();
    assert.equal(row.original_url,'https://example.org/news/1');
    assert.equal(row.google_news_url,'https://news.google.com/rss/articles/a');
    assert.equal(row.publisher_title,'قرار البناء في إدلب');
  } finally {sqlite.close();}
});

test('secondary lookup verifies title and source before accepting an original link', async () => {
  const title='إعلان افتتاح مركز صحي جديد في حلب';
  const fetcher=async url=>{
    const u=String(url);
    if(u.endsWith('/robots.txt')) return new Response('User-agent: *\nAllow: /');
    if(u.endsWith('/feed/')) return new Response(`<rss><item><title>${title}</title><link>https://example.org/article</link></item></rss>`);
    return new Response(`<meta property="og:title" content="${title}">`,{headers:{'content-type':'text/html'}});
  };
  const found=await engine.lookupPublisherFeed(title+' - المثال','المثال','https://example.org','https://news.google.com/rss/articles/id',null,fetcher);
  assert.equal(found.originalUrl,'https://example.org/article');
  assert.equal(found.googleNewsUrl,'https://news.google.com/rss/articles/id');
  assert.equal(found.resolutionStatus,'verified_publisher_feed');
  assert.equal(await engine.lookupPublisherFeed('مقال آخر تماماً ولا يطابق','المثال','https://example.org','https://news.google.com/rss/articles/id',null,fetcher),null);
  const wrongPage=async url => String(url).endsWith('/article') ? new Response('<meta property="og:title" content="عنوان لا يطابق الخبر">',{headers:{'content-type':'text/html'}}) : fetcher(url);
  assert.equal(await engine.lookupPublisherFeed(title+' - المثال','المثال','https://example.org','https://news.google.com/rss/articles/id',null,wrongPage),null);
  const noCrawl=async url => String(url).endsWith('/robots.txt') ? new Response('User-agent: *\nDisallow: /feed/') : fetcher(url);
  assert.equal(await engine.lookupPublisherFeed(title+' - المثال','المثال','https://example.org','https://news.google.com/rss/articles/id',null,noCrawl),null);
});
