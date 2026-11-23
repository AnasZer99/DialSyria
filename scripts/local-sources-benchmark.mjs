import {readFile,writeFile} from 'node:fs/promises';
import {loadEngine,openDatabase} from './discovery-runtime.mjs';
const fixtures=JSON.parse(await readFile('tests/fixtures/local-nontraditional.json','utf8'));
const engine=await loadEngine(); const {db,sqlite}=await openDatabase(':memory:');
const results=[];
try {
 for(const item of fixtures) {
   const report=await engine.runDiscovery(db,item.interest);
   results.push({fixture:item,report});
   await writeFile('.wrangler/discovery/nontraditional-results.json',JSON.stringify(results,null,2),'utf8');
   console.error(`${item.id}: ${report.decisions.length} candidates, ${report.errors.length} errors`);
 }
} finally {sqlite.close();}
