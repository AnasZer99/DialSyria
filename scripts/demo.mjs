import { build } from 'esbuild';
import { randomBytes } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { createInterface } from 'node:readline/promises';
import { pathToFileURL } from 'node:url';
import { openDatabase } from './discovery-runtime.mjs';

// Bundle the existing Cloudflare modules without changing application code or writing
// generated artifacts. The D1-compatible adapter uses an isolated in-memory SQLite DB.
async function loadModule(entry) {
  const result = await build({ entryPoints: [entry], bundle: true, platform: 'neutral', format: 'esm', write: false });
  return import('data:text/javascript;base64,' + Buffer.from(result.outputFiles[0].contents).toString('base64'));
}

const oneLine = value => String(value ?? '').replace(/[\x00-\x1f\x7f-\x9f]/g, ' ').trim();
const safeError = (error, token = '') => oneLine(error instanceof Error ? error.message : error).replaceAll(token || '\0', '[redacted]');

export async function fetchLiveNews({ fetcher = globalThis.fetch, log = console.log } = {}) {
  const [ingest, digest] = await Promise.all([loadModule('functions/api/_ingest.ts'), loadModule('functions/api/_digest.ts')]);
  const { db, sqlite } = await openDatabase(':memory:');
  try {
    sqlite.exec(await readFile('schema.sql', 'utf8'));
    const now = new Date().toISOString();
    sqlite.prepare('INSERT INTO subscribers (id,email,status,language,created_at) VALUES (?,?,?,?,?)')
      .run('local-demo', 'local-demo@example.invalid', 'active', 'ar', now);
    sqlite.prepare('INSERT INTO subscriber_topics (subscriber_id,topic) VALUES (?,?)').run('local-demo', 'politics');
    const originalFetch = globalThis.fetch;
    let feedNumber = 0;
    const feedUrls = new Set(ingest.FEEDS.map(feed => feed.url));
    globalThis.fetch = async (input, init) => {
      const requestUrl = String(input);
      if (feedUrls.has(requestUrl)) {
        feedNumber++;
        log(`  RSS ${feedNumber}/${ingest.FEEDS.length}: ${new URL(requestUrl).hostname}`);
      }
      try { return await fetcher(input, init); }
      catch (error) {
        const code = error?.cause?.code;
        // The ingestion module records error messages; retain a non-sensitive TLS or
        // connection error code so a failed live run is actionable.
        if (typeof code === 'string' && /^[A-Z0-9_]+$/.test(code)) throw new Error(`fetch failed (${code})`);
        throw error;
      }
    };
    let report;
    try { report = await ingest.runIngestion({ DB: db }); }
    finally { globalThis.fetch = originalFetch; }
    const articles = sqlite.prepare('SELECT title, source, url, published_at, topic, scope FROM articles ORDER BY published_at IS NULL, published_at DESC, title').all();
    return { report, articles, digestText: digest.digestText };
  } finally { sqlite.close(); }
}

// Telegram responses and network exceptions are sanitized before they reach the CLI.
export async function telegramRequest(token, method, payload, fetcher = globalThis.fetch) {
  let response;
  try {
    response = await fetcher(`https://api.telegram.org/bot${token}/${method}`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify(payload), signal: AbortSignal.timeout(method === 'getUpdates' ? 30000 : 15000),
    });
  } catch (error) { throw new Error(`Telegram network error: ${safeError(error, token)}`); }
  let data;
  try { data = await response.json(); }
  catch { throw new Error(`Telegram returned HTTP ${response.status} without a valid JSON response`); }
  if (!response.ok || !data.ok) {
    const detail = safeError(typeof data.description === 'string' ? data.description : 'unknown error', token);
    throw new Error(`Telegram HTTP ${response.status}: ${detail}`);
  }
  return data.result;
}

export async function waitForPrivateChat(token, challenge, { fetcher = globalThis.fetch, timeoutMs = 120000 } = {}) {
  const deadline = Date.now() + timeoutMs;
  let offset = 0;
  while (Date.now() < deadline) {
    const remainingSeconds = Math.max(1, Math.min(20, Math.ceil((deadline - Date.now()) / 1000)));
    const updates = await telegramRequest(token, 'getUpdates', { offset, timeout: remainingSeconds }, fetcher);
    if (!Array.isArray(updates)) throw new Error('Telegram returned an invalid updates list');
    for (const update of updates) {
      if (Number.isSafeInteger(update.update_id)) offset = Math.max(offset, update.update_id + 1);
      const msg = update.message;
      if (msg?.text === challenge && msg.chat?.type === 'private' && Number.isSafeInteger(msg.chat.id)
          && msg.chat.id > 0 && msg.from?.id === msg.chat.id) return String(msg.chat.id);
    }
  }
  throw new Error('Timed out waiting for the verification message in a private chat');
}

export async function sendPreview(token, chatId, text, confirmation, fetcher = globalThis.fetch) {
  if (confirmation !== 'SEND') return { sent: false };
  if (!/^[1-9]\d*$/.test(chatId)) throw new Error('Refusing a non-private chat identifier');
  if (!text || text.length > 3900) throw new Error('The preview is empty or too long to send as one message');
  await telegramRequest(token, 'sendMessage', { chat_id: chatId, text, link_preview_options: { is_disabled: true } }, fetcher);
  return { sent: true };
}

function previewFor(articles, digestText) {
  for (let count = Math.min(3, articles.length); count > 0; count--) {
    const chosen = articles.slice(0, count).map(article => ({ ...article, title: oneLine(article.title).slice(0, 180), source: oneLine(article.source), summary: null }));
    const text = digestText('ar', [{ title: 'عرض محلي: أخبار RSS حقيقية', items: chosen }])
      + '\n\nالمصادر والتواريخ:\n' + chosen.map((article, i) => `${i + 1}. ${oneLine(article.published_at) || 'التاريخ غير متاح'}\n${oneLine(article.url)}`).join('\n');
    if (text.length <= 3900) return text;
  }
  throw new Error('The article links are too long for one Telegram message');
}

async function ask(prompt) {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try { return (await rl.question(prompt)).trim(); }
  finally { rl.close(); }
}

// Raw terminal mode prevents the operating system from echoing the bot token.
async function readSecret(prompt) {
  if (!process.stdin.isTTY || !process.stdout.isTTY) throw new Error('An interactive terminal is required to enter the bot token securely');
  process.stdout.write(prompt);
  process.stdin.setRawMode(true);
  process.stdin.resume();
  return new Promise((resolve, reject) => {
    let secret = '';
    const done = (error) => {
      process.stdin.off('data', onData);
      process.stdin.setRawMode(false);
      process.stdin.pause();
      process.stdout.write('\n');
      if (error) reject(error); else resolve(secret.trim());
    };
    const onData = chunk => {
      for (const char of chunk.toString('utf8')) {
        if (char === '\u0003') return done(new Error('Cancelled'));
        if (char === '\r' || char === '\n') return done();
        if (char === '\u007f' || char === '\b') secret = secret.slice(0, -1);
        else if (char >= ' ' && char !== '\u001b') secret += char;
      }
    };
    process.stdin.on('data', onData);
  });
}

async function main() {
  console.log('DialSyria local demo — legacy RSS news; in-memory local test subscriber; no Brevo.');
  console.log('Personalized live interest discovery is not connected. Mock news is not used.');
  console.log('Fetching live RSS feeds; this can take a few minutes...');
  const { report, articles, digestText } = await fetchLiveNews();
  console.log(`\n${articles.length} articles, ${report.feeds_ok} working feeds, ${report.feeds_fail} failed feeds.`);
  if (report.failed.length) for (const error of report.failed) console.log(`  Feed error: ${oneLine(error)}`);
  if (!articles.length) {
    console.error('No real articles could be fetched. No sample digest can be sent.');
    process.exitCode = 1;
    return;
  }
  console.log('\nLatest real RSS items (Google News links may be intermediary links):');
  for (const [i, article] of articles.slice(0, 20).entries()) {
    console.log(`${i + 1}. ${oneLine(article.title)}\n   ${oneLine(article.source)} | ${oneLine(article.published_at) || 'date unavailable'} | ${oneLine(article.scope)} / ${oneLine(article.topic)}\n   ${oneLine(article.url)}`);
  }
  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    console.log('\nNon-interactive terminal: Telegram was skipped. Run npm run demo in a terminal to connect the test bot.');
    return;
  }
  const token = await readSecret('\nDedicated test bot token (hidden; Enter skips Telegram): ');
  if (!token) { console.log('Telegram skipped.'); return; }
  if (!/^\d+:[A-Za-z0-9_-]+$/.test(token)) throw new Error('Invalid bot token format');
  try {
    const bot = await telegramRequest(token, 'getMe', {});
    if (!bot?.is_bot || !/^[A-Za-z0-9_]{5,32}$/.test(bot.username || '')) throw new Error('Telegram did not return a valid bot username');
    const challenge = '/start demo_' + randomBytes(8).toString('hex');
    console.log(`Open https://t.me/${bot.username} in Telegram and send this exact message in your private chat:\n${challenge}`);
    console.log('Waiting up to two minutes. A bot with an active webhook cannot use polling; use a dedicated bot without a webhook.');
    const chatId = await waitForPrivateChat(token, challenge);
    const preview = previewFor([...articles.filter(article => article.scope === 'syria'), ...articles.filter(article => article.scope !== 'syria')], digestText);
    console.log(`\nVerified private chat: ${chatId}\n\n--- Message preview ---\n${preview}\n--- End preview ---`);
    const answer = await ask('Type SEND to send this one real Telegram message; anything else cancels: ');
    const outcome = await sendPreview(token, chatId, preview, answer);
    console.log(outcome.sent ? 'Telegram accepted the message.' : 'Cancelled; no message sent.');
  } catch (error) { throw new Error(safeError(error, token)); }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch(error => { console.error(`Demo error: ${safeError(error)}`); process.exitCode = 1; });
}
