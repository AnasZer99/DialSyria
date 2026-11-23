import { loadEngine, openDatabase } from './discovery-runtime.mjs';

const args = process.argv.slice(2);
const brave = args.includes('--brave');
const interest = args.filter(x => x !== '--brave').join(' ').trim();
if (!interest) { console.error('Usage: node scripts/discover.mjs "interest" [--brave]'); process.exit(1); }
if (brave && !process.env.BRAVE_SEARCH_API_KEY) { console.error('BRAVE_SEARCH_API_KEY is required with --brave'); process.exit(1); }
const engine = await loadEngine();
const { db, sqlite } = await openDatabase('.wrangler/discovery/local.sqlite');
try { const report = await engine.runDiscovery(db, interest, { key: brave ? process.env.BRAVE_SEARCH_API_KEY : undefined }); console.log(JSON.stringify(report, null, 2)); }
finally { sqlite.close(); }
