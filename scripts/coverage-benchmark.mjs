import {readFile,writeFile} from 'node:fs/promises';
import {loadEngine,openDatabase} from './discovery-runtime.mjs';
const fixtures=JSON.parse(await readFile('tests/fixtures/local-coverage.json','utf8'));
// A fresh database prevents a previous run from seeding the search with source hosts.
const engine=await loadEngine(); const {db,sqlite}=await openDatabase(':memory:');
const results=[];
try {
  for(const item of fixtures) {
    // Only the interest is passed into the engine; target titles and URLs are used afterward.
    const report=await engine.runDiscovery(db,item.interest);
    const key=engine.normalize(item.title);
    const matches=report.decisions.filter(d=>{ const t=engine.normalize(d.title.split(' - ')[0]); return t===key || (t.length>25 && (t.includes(key)||key.includes(t))); });
    const outcome=matches.some(x=>x.accepted)?'accepted':matches.length?'returned_but_rejected':'not_returned';
    results.push({fixture:item,report,outcome,matches});
    await writeFile('.wrangler/discovery/coverage-results-v2.json',JSON.stringify(results,null,2),'utf8');
    console.error(`${item.id}: ${outcome}, ${report.decisions.length} results, ${report.errors.length} errors`);
  }
} finally {sqlite.close();}
