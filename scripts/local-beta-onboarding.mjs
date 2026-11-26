// Isolated local Pages and D1. The simulator exists only in a temporary project;
// it never calls Telegram and is not copied into the application or deployed.
import {mkdir,writeFile,cp,copyFile,mkdtemp} from 'node:fs/promises';
import {spawn,spawnSync} from 'node:child_process';
import {resolve,join} from 'node:path';
import {tmpdir} from 'node:os';
const root=process.cwd(), project=await mkdtemp(join(tmpdir(),'dialsyria-onboarding-'));
const persist=resolve('.wrangler/beta-onboarding'),wrangler=resolve('node_modules/wrangler/bin/wrangler.js');
const env={...process.env,WRANGLER_SEND_METRICS:'false',CLOUDFLARE_INCLUDE_PROCESS_ENV:'false',CLOUDFLARE_LOAD_DEV_VARS_FROM_DOT_ENV:'false'};
function run(args,cwd=root){const p=spawnSync(process.execPath,args,{cwd,stdio:'inherit',env});if(p.error)throw p.error;if(p.status!==0)throw Error(`Local setup exited ${p.status}`);}
try{
 await mkdir(persist,{recursive:true});
 await cp('functions',resolve(project,'functions'),{recursive:true});await cp('migrations',resolve(project,'migrations'),{recursive:true});await copyFile('wrangler.toml',resolve(project,'wrangler.toml'));
 await writeFile(resolve(project,'.dev.vars'),'TELEGRAM_DELIVERY_ENABLED=0\nALLOW_MOCK_DISCOVERY=0\nBETA_ALLOWED_TELEGRAM_IDS=10002,10003\nBETA_DURATION_DAYS=30\n',{mode:0o600});
 await writeFile(resolve(project,'functions/api/beta-simulator.ts'),`import {allowedOrigin,claimBetaStart,approveBeta} from './_beta';\nimport {json,fail,readJson,type Handler} from './_lib';\nexport const onRequestPost:Handler=async({request,env})=>{if(!allowedOrigin(request)||new URL(request.url).hostname!=='127.0.0.1')return fail('local only',403);const b=await readJson<{token?:string;id?:string}>(request);if(typeof b.token!=='string')return fail('invalid');const id=b.id==='10002'?'10002':'10003';const claimed=await claimBetaStart(env,b.token,id);if(!claimed||!await approveBeta(env,b.token,id))return fail('expired',410);return json({ok:true});};\n`);
 run([resolve('node_modules/typescript/bin/tsc'),'--noEmit']);run([resolve('node_modules/vite/bin/vite.js'),'build']);await cp('dist',resolve(project,'dist'),{recursive:true});
 run([wrangler,'d1','execute','dialsyria-db','--local','--persist-to',persist,'--file',resolve('schema.sql')],project);
 run([wrangler,'d1','migrations','apply','dialsyria-db','--local','--persist-to',persist,'--force'],project);
 console.log('\nOpen http://127.0.0.1:8788/beta — choose the local Telegram simulation button. No Telegram messages or remote D1 calls are made. Stop with Ctrl+C.');
 const server=spawn(process.execPath,[wrangler,'pages','dev',resolve(project,'dist'),'--ip','127.0.0.1','--port','8788','--persist-to',persist,'--log-level','error'],{cwd:project,stdio:'inherit',env});
 server.on('error',error=>{console.error('Local server failed:',error.message);process.exitCode=1;});server.on('exit',code=>{process.exitCode=code ?? 0;});process.on('SIGINT',()=>server.kill('SIGINT'));
}catch(error){console.error('Local setup failed:',error instanceof Error?error.message:String(error));process.exitCode=1;}
