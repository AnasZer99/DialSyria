import { build } from 'esbuild';
import { DatabaseSync } from 'node:sqlite';
import { readFile } from 'node:fs/promises';

// Keep compiled test modules in memory. Parallel test processes previously wrote the
// same files, which can fail on Windows when another process has a module mapped.
async function loadBundle(entry) {
  const result=await build({entryPoints:[entry],bundle:true,platform:'neutral',format:'esm',write:false});
  return import('data:text/javascript;base64,'+Buffer.from(result.outputFiles[0].contents).toString('base64'));
}

export async function loadEngine() {
  return loadBundle('functions/api/_discovery.ts');
}
export async function loadDirect() {
  return loadBundle('functions/api/_direct.ts');
}
export async function loadDirectRoute() { return loadBundle('functions/api/direct.ts'); }
export async function loadInterests() {
  return loadBundle('functions/api/interests.ts');
}
export async function loadInterestDiscovery() {
  return loadBundle('functions/api/interests/discover.ts');
}
export async function loadLiveInterest() { return loadBundle('functions/api/_live_interest.ts'); }
export async function loadLiveBudget() { return loadBundle('functions/api/_live_budget.ts'); }
export async function loadNotify() {
  return loadBundle('functions/api/_notify.ts');
}
export async function loadNotifyRoute() {
  return loadBundle('functions/api/notify.ts');
}
export async function loadBetaScheduledRoute() { return loadBundle('functions/api/beta-scheduled.ts'); }
export async function loadSubscribe() {
  return loadBundle('functions/api/subscribe.ts');
}
export async function loadTelegramLink() {
  return loadBundle('functions/api/telegram/link.ts');
}
export async function loadTelegram() {
  return loadBundle('functions/api/telegram.ts');
}
export async function loadBeta() {
  return loadBundle('functions/api/beta.ts');
}
export async function loadDigest() {
  return loadBundle('functions/api/_digest.ts');
}
export async function loadStagingMiddleware() {
  return loadBundle('functions/_middleware.ts');
}
export async function openDatabase(filename) {
  const sqlite = new DatabaseSync(filename);
  sqlite.exec('CREATE TABLE IF NOT EXISTS _local_discovery_migrations (name TEXT PRIMARY KEY)');
  for (const name of ['0001_discovery.sql','0002_discovery_provenance.sql','0003_direct_sources.sql','0004_subscriber_interests.sql','0005_discovery_mock_flag.sql','0006_notifications.sql','0007_telegram_link_tokens.sql','0008_notification_delivery_claim.sql','0009_direct_verification.sql','0010_beta_auth.sql','0011_beta_delivery.sql','0012_interest_monitor_jobs.sql','0013_direct_monitor_progress.sql']) {
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
