// Live, free-provider smoke test; uses only an in-memory database and synthetic
// subscriber credentials. No reference article/source URLs are supplied.
import { build } from 'esbuild';
import { readFile } from 'node:fs/promises';
import { openDatabase } from './discovery-runtime.mjs';

const output = await build({ entryPoints:['functions/api/interests/discover.ts'], bundle:true, platform:'neutral', format:'esm', write:false });
const route = await import('data:text/javascript;base64,' + Buffer.from(output.outputFiles[0].contents).toString('base64'));
const {db,sqlite} = await openDatabase(':memory:');
sqlite.exec(await readFile('schema.sql','utf8'));
sqlite.prepare('INSERT INTO subscribers(id,email,status,created_at,magic_token,magic_expires) VALUES(?,?,?,?,?,?)')
  .run('smoke','smoke@example.invalid','active',new Date().toISOString(),'local-smoke-token','2999-01-01');
const interests = ['قرارات جامعة إدلب المتعلقة بالامتحانات والتسجيل','قرارات وزارة التعليم العالي السورية المتعلقة بالقبول الجامعي','مشاريع الخدمات والبنية التحتية في إدلب'];
try {
  for (const [index,text] of interests.entries()) {
    const id='smoke-'+index;
    sqlite.prepare('INSERT INTO subscriber_interests(id,subscriber_id,text,normalized_text,created_at,updated_at) VALUES(?,?,?,?,?,?)')
      .run(id,'smoke',text,id,new Date().toISOString(),new Date().toISOString());
    process.stdout.write(`Testing ${index+1}/${interests.length}: ${text}\n`);
    const request=new Request('https://example.invalid/api/interests/discover',{method:'POST',headers:{authorization:'Bearer local-smoke-token','content-type':'application/json'},body:JSON.stringify({id,mode:'live'})});
    const response=await route.onRequestPost({request,env:{DB:db},params:{},waitUntil(){}});
    const body=await response.json();
    console.log(JSON.stringify({interest:text,httpStatus:response.status,...(response.ok ? {diagnostics:body.diagnostics,results:body.results} : {error:body.error})}));
  }
} finally { sqlite.close(); }
