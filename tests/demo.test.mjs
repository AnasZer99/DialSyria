import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fetchLiveNews, sendPreview, telegramRequest, waitForPrivateChat } from '../scripts/demo.mjs';

test('demo RSS ingestion uses the existing pipeline with isolated mocked feeds', async () => {
  const xml = '<rss><channel><item><title>قرار محلي جديد في مدينة إدلب</title><link>https://example.org/real-shaped-article</link><pubDate>Tue, 24 Nov 2026 10:00:00 GMT</pubDate><description>تقرير اختباري فقط لا يمثل خبرا حقيقيا وفيه وصف طويل يتجاوز الحد المطلوب للاختبار.</description><source>مصدر اختبار</source></item></channel></rss>';
  let requests = 0;
  const { report, articles } = await fetchLiveNews({ fetcher: async () => { requests++; return new Response(xml, { status: 200 }); }, log: () => {} });
  assert.equal(report.feeds_fail, 0);
  assert.equal(report.feeds_ok, requests);
  assert.ok(report.feeds_ok > 0);
  assert.equal(articles.length, 1);
  assert.equal(articles[0].url, 'https://example.org/real-shaped-article');
  assert.ok(articles[0].published_at);
});

test('chat verification accepts only the matching challenge from a private user', async () => {
  const updates = [
    { update_id: 1, message: { text: '/start demo_123', chat: { id: -100, type: 'group' }, from: { id: 12 } } },
    { update_id: 2, message: { text: '/start demo_123', chat: { id: 12, type: 'private' }, from: { id: 99 } } },
    { update_id: 3, message: { text: '/start unrelated', chat: { id: 12, type: 'private' }, from: { id: 12 } } },
    { update_id: 4, message: { text: '/start demo_123', chat: { id: 12, type: 'private' }, from: { id: 12 } } },
  ];
  const chat = await waitForPrivateChat('123:synthetic', '/start demo_123', { fetcher: async () => new Response(JSON.stringify({ ok: true, result: updates }), { status: 200 }) });
  assert.equal(chat, '12');
});

test('a real send requires exact confirmation and one verified private recipient', async () => {
  const requests = [];
  const fetcher = async (input, init) => { requests.push({ input, body: JSON.parse(init.body) }); return new Response('{"ok":true,"result":{}}', { status: 200 }); };
  assert.deepEqual(await sendPreview('123:synthetic','12','real-shaped preview','yes',fetcher), { sent: false });
  assert.equal(requests.length, 0);
  await assert.rejects(() => sendPreview('123:synthetic','-100','preview','SEND',fetcher), /non-private/);
  assert.equal(requests.length, 0);
  assert.deepEqual(await sendPreview('123:synthetic','12','preview','SEND',fetcher), { sent: true });
  assert.equal(requests.length, 1);
  assert.equal(requests[0].body.chat_id, '12');
});

test('Telegram failures never expose the bot token', async () => {
  const token = '123:synthetic-secret';
  await assert.rejects(() => telegramRequest(token, 'getMe', {}, async input => { throw new Error(`network failed ${input}`); }), error => !error.message.includes(token));
  await assert.rejects(() => telegramRequest(token, 'getMe', {}, async () => new Response(JSON.stringify({ ok: false, description: `bad ${token}` }), { status: 401 })), error => !error.message.includes(token));
});
