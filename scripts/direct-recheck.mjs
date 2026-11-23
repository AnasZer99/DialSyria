import {readFile,writeFile} from 'node:fs/promises';
import {loadDirect,openDatabase} from './discovery-runtime.mjs';
const fixtures=JSON.parse(await readFile('tests/fixtures/local-nontraditional.json','utf8'));
const interest=fixtures.find(x=>x.id==='telegram-health').interest;
const engine=await loadDirect();const {db,sqlite}=await openDatabase(':memory:');
try {const discovery=await engine.discoverDirectSources(db,interest);const monitor=await engine.monitorDirectSources(db,interest);const repeat=await engine.monitorDirectSources(db,interest);const report={discovery,monitor,repeat};await writeFile('.wrangler/discovery/direct-health-recheck.json',JSON.stringify(report,null,2),'utf8');console.log(JSON.stringify(report,null,2));}finally{sqlite.close();}
