import {readFile,writeFile} from 'node:fs/promises';
import {loadDirect,openDatabase} from './discovery-runtime.mjs';
const fixtures=JSON.parse(await readFile('tests/fixtures/local-nontraditional.json','utf8'));
const engine=await loadDirect();const {db,sqlite}=await openDatabase(':memory:'); const runs=[];
try {
  for(const fixture of fixtures) {
    // Neither reference URL nor event text is passed to either phase.
    const discovery=await engine.discoverDirectSources(db,fixture.interest);
    const monitor=await engine.monitorDirectSources(db,fixture.interest);
    const repeat=monitor.sources.length ? await engine.monitorDirectSources(db,fixture.interest) : null;
    runs.push({fixture,discovery,monitor,repeat});
    await writeFile('.wrangler/discovery/direct-live.json',JSON.stringify(runs,null,2),'utf8');
    console.error(`${fixture.id}: sources=${discovery.discovered.length}, items=${monitor.items.length}, errors=${discovery.errors.length+monitor.errors.length}`);
    if(discovery.errors.some(e=>e.includes('429') || e.includes('cooldown'))) { console.error('Stopping: provider throttling; remaining interests not tested.'); break; }
    await new Promise(resolve=>setTimeout(resolve,1500));
  }
} finally {sqlite.close();}
