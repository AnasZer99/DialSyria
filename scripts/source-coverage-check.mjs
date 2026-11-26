// Live source-only check of the three requested interests. No Google search, bot
// calls or historical-reference URLs are used. All data lives in SQLite memory.
import {build} from 'esbuild';
import {readFile} from 'node:fs/promises';
import {openDatabase} from './discovery-runtime.mjs';
const bundle=async path=>{const b=await build({entryPoints:[path],bundle:true,platform:'neutral',format:'esm',write:false});return import('data:text/javascript;base64,'+Buffer.from(b.outputFiles[0].contents).toString('base64'));};
const direct=await bundle('functions/api/_direct.ts'), catalog=await bundle('functions/api/_source_catalog.ts'), notify=await bundle('functions/api/_notify.ts'), engine=await bundle('functions/api/_discovery.ts');
const interests=['قرارات جامعة إدلب المتعلقة بالامتحانات والتسجيل','قرارات وزارة التعليم العالي السورية المتعلقة بالقبول الجامعي','مشاريع الخدمات والبنية التحتية في إدلب'];
const {db,sqlite}=await openDatabase(':memory:');sqlite.exec(await readFile('schema.sql','utf8'));
sqlite.prepare('INSERT INTO subscribers(id,email,status,created_at) VALUES(?,?,?,?)').run('source-test','source-test@example.invalid','active',new Date().toISOString());
try {
 for(const [i,interest] of interests.entries()){
  const id='source-interest-'+i,now=new Date().toISOString();
  sqlite.prepare('INSERT INTO subscriber_interests(id,subscriber_id,text,normalized_text,created_at,updated_at) VALUES(?,?,?,?,?,?)').run(id,'source-test',interest,engine.normalize(interest),now,now);
  const candidates=await catalog.attachCandidateSources(db,interest);
  let requests=0;const bounded=async (url,init)=>{if(requests>=24)throw Error('network request budget exhausted');requests++;return fetch(url,init);};
  const report=await direct.monitorDirectSources(db,interest,{fetcher:bounded});
  const prepared=await notify.prepareNotifications(db,'source-test');
  console.log(JSON.stringify({interest,candidates:candidates.map(x=>({url:x.url,enabled:x.enabled,reason:x.reason})),requests,observations:report.observations,errors:report.errors,items:report.items,preparedForSubscriber:prepared.items.map(x=>({title:x.title,url:x.url}))}));
 }
}finally{sqlite.close();}
