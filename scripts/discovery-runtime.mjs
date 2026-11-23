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
export async function openDatabase(filename) {
  const sqlite = new DatabaseSync(filename);
  sqlite.exec('CREATE TABLE IF NOT EXISTS _local_discovery_migrations (name TEXT PRIMARY KEY)');
  for (const name of ['0001_discovery.sql','0002_discovery_provenance.sql','0003_direct_sources.sql']) {
    if (!sqlite.prepare('SELECT name FROM _local_discovery_migrations WHERE name=?').get(name)) {
      sqlite.exec(await readFile('migrations/' + name, 'utf8'));
      sqlite.prepare('INSERT INTO _local_discovery_migrations(name) VALUES (?)').run(name);
    }
  }
  const db = { prepare(sql) { return { bind(...params) { const stmt = sqlite.prepare(sql); return {
    async first() { return stmt.get(...params) ?? null; },
    async all() { return { results: stmt.all(...params) }; },
    async run() { const r = stmt.run(...params); return { meta: { changes: Number(r.changes) } }; }
  }; } }; } };
  return { db, sqlite };
}
