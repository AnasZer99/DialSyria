import { writeFile } from 'node:fs/promises';
import { loadEngine, openDatabase } from './discovery-runtime.mjs';
const interests = ['قرارات البناء والتراخيص في إدلب','تحديثات خدمات الكهرباء والمياه في حلب','القوانين الجديدة المتعلقة باستيراد السيارات إلى سوريا'];
const engine = await loadEngine();
const {db, sqlite} = await openDatabase('.wrangler/discovery/trials-v2.sqlite');
const reports = [];
try {
  for (const interest of interests) for (let run=1;run<=2;run++) {
    const report = await engine.runDiscovery(db,interest);
    reports.push({run,...report});
    console.error(`${interest} run ${run}: ${report.decisions.length} results, ${report.errors.length} errors`);
    await writeFile('.wrangler/discovery/live-trials.json',JSON.stringify(reports,null,2),'utf8');
  }
} finally { sqlite.close(); }
