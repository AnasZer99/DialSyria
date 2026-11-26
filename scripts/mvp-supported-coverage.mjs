// Run on public source listings and an isolated in-memory database. The frozen
// reference URLs are read only after all engine calls complete for comparison.
import {build} from 'esbuild';
import {readFile} from 'node:fs/promises';
import {openDatabase} from './discovery-runtime.mjs';
const load = async path => {const b=await build({entryPoints:[path],bundle:true,platform:'neutral',format:'esm',write:false});return import('data:text/javascript;base64,'+Buffer.from(b.outputFiles[0].contents).toString('base64'));};
const direct=await load('functions/api/_direct.ts'), catalog=await load('functions/api/_source_catalog.ts');
// These natural interests are fixed independently of the reference URLs.
const interests=['أخبار وإعلانات جامعة إدلب','آخر أخبار وإعلانات وزارة التعليم العالي','مشاريع الخدمات والبنية التحتية في إدلب'];
const {db,sqlite}=await openDatabase(':memory:');sqlite.exec(await readFile('schema.sql','utf8'));
const results=[];
try {
 for (const interest of interests) {
  const candidates=await catalog.attachCandidateSources(db,interest);let requests=0;
  const bounded=async (url,init={})=>{if(++requests>24)throw Error('request limit');const timeout=AbortSignal.timeout(8000);return fetch(url,{...init,signal:init.signal?AbortSignal.any([init.signal,timeout]):timeout});};
  const cycles=[];
  for(let i=0;i<2;i++) {
   const report=await direct.monitorDirectSources(db,interest,{fetcher:bounded});
   cycles.push({observations:report.observations,errors:report.errors,incomplete:report.incomplete,items:report.items});
  }
  const items=[...new Map(cycles.flatMap(c=>c.items).map(item=>[item.url,item])).values()];
  results.push({interest,candidates:candidates.filter(x=>x.enabled).map(x=>x.id),requests,cycles,items});
 }
 const references=JSON.parse(await readFile(process.argv[2] || 'tests/fixtures/mvp-supported-reference.json','utf8'));
 for(const result of results) {
  const sample=references.cases.find(x=>x.interest===result.interest);
  result.references=sample.events.map(event=>({...event,found:result.items.some(item=>item.url.replace(/\/$/,'')===event.url.replace(/\/$/,''))}));
  console.log(JSON.stringify(result));
 }
} finally {sqlite.close();}
