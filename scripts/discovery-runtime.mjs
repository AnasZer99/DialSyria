import { build } from 'esbuild';
import { DatabaseSync } from 'node:sqlite';
import { readFile, mkdir } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import { resolve } from 'node:path';

export async function loadEngine() {
  await mkdir('.wrangler/discovery', { recursive: true });
  const outfile = resolve('.wrangler/discovery/engine.mjs');
  await build({ entryPoints: ['functions/api/_discovery.ts'], bundle: true, platform: 'neutral', format: 'esm', outfile });
  return import(pathToFileURL(outfile).href + '?v=' + Date.now());
}
export async function loadDirect() {
  await mkdir('.wrangler/discovery', { recursive: true });
  const outfile = resolve('.wrangler/discovery/direct-engine.mjs');
  await build({ entryPoints: ['functions/api/_direct.ts'], bundle: true, platform: 'neutral', format: 'esm', outfile });
  return import(pathToFileURL(outfile).href + '?v=' + Date.now());
}
export async function loadInterests() {
  await mkdir('.wrangler/discovery', { recursive: true });
  const outfile = resolve('.wrangler/discovery/interests-engine.mjs');
  await build({ entryPoints: ['functions/api/interests.ts'], bundle: true, platform: 'neutral', format: 'esm', outfile });
  return import(pathToFileURL(outfile).href + '?v=' + Date.now());
}
export async function loadInterestDiscovery() {
  await mkdir('.wrangler/discovery', { recursive: true });
  const outfile = resolve('.wrangler/discovery/interest-discovery-engine.mjs');
  await build({ entryPoints: ['functions/api/interests/discover.ts'], bundle: true, platform: 'neutral', format: 'esm', outfile });
  return import(pathToFileURL(outfile).href + '?v=' + Date.now());
}
export async function loadNotify() {
  await mkdir('.wrangler/discovery', { recursive: true });
  const outfile = resolve('.wrangler/discovery/notify-engine.mjs');
  await build({ entryPoints: ['functions/api/_notify.ts'], bundle: true, platform: 'neutral', format: 'esm', outfile });
  return import(pathToFileURL(outfile).href + '?v=' + Date.now());
}
export async function loadNotifyRoute() {
  await mkdir('.wrangler/discovery', { recursive: true });
  const outfile = resolve('.wrangler/discovery/notify-route.mjs');
  await build({ entryPoints: ['functions/api/notify.ts'], bundle: true, platform: 'neutral', format: 'esm', outfile });
  return import(pathToFileURL(outfile).href + '?v=' + Date.now());
}
export async function loadSubscribe() {
  await mkdir('.wrangler/discovery', { recursive: true });
  const outfile = resolve('.wrangler/discovery/subscribe-engine.mjs');
  await build({ entryPoints: ['functions/api/subscribe.ts'], bundle: true, platform: 'neutral', format: 'esm', outfile });
  return import(pathToFileURL(outfile).href + '?v=' + Date.now());
}
export async function loadTelegramLink() {
  await mkdir('.wrangler/discovery', { recursive: true });
  const outfile = resolve('.wrangler/discovery/telegram-link-engine.mjs');
  await build({ entryPoints: ['functions/api/telegram/link.ts'], bundle: true, platform: 'neutral', format: 'esm', outfile });
  return import(pathToFileURL(outfile).href + '?v=' + Date.now());
}
export async function loadTelegram() {
  await mkdir('.wrangler/discovery', { recursive: true });
  const outfile = resolve('.wrangler/discovery/telegram-engine.mjs');
  await build({ entryPoints: ['functions/api/telegram.ts'], bundle: true, platform: 'neutral', format: 'esm', outfile });
  return import(pathToFileURL(outfile).href + '?v=' + Date.now());
}
export async function openDatabase(filename) {
  const sqlite = new DatabaseSync(filename);
  sqlite.exec('CREATE TABLE IF NOT EXISTS _local_discovery_migrations (name TEXT PRIMARY KEY)');
  for (const name of ['0001_discovery.sql','0002_discovery_provenance.sql','0003_direct_sources.sql','0004_subscriber_interests.sql','0005_discovery_mock_flag.sql','0006_notifications.sql','0007_telegram_link_tokens.sql','0008_notification_delivery_claim.sql']) {
    if (!sqlite.prepare('SELECT name FROM _local_discovery_migrations WHERE name=?').get(name)) {
      sqlite.exec(await readFile('migrations/' + name, 'utf8'));
      sqlite.prepare('INSERT INTO _local_discovery_migrations(name) VALUES (?)').run(name);
    }
  }
  const db = { prepare(sql) { return { bind(...params) { const stmt = sqlite.prepare(sql); return {
    async first() { return stmt.get(...params) ?? null; },
    async all() { return { results: stmt.all(...params) }; },
    async run() { const r = stmt.run(...params); return { meta: { changes: Number(r.changes) } }; },
    _sql: sql, _params: params,
  }; } }; },
  // Minimal D1 batch(): sequential execution; SELECT batches expose results, writes expose changes.
  async batch(statements) { const out = []; for (const statement of statements) {
    const sql = String(statement._sql || ''); const params = statement._params || [];
    if (/^\s*select/i.test(sql)) out.push({ results: sqlite.prepare(sql).all(...params), meta: { changes: 0 } });
    else { const r = sqlite.prepare(sql).run(...params); out.push({ results: [], meta: { changes: Number(r.changes) } }); }
  } return out; },
  };
  return { db, sqlite };
}
