// Explicitly local Pages + isolated D1 for browser testing. No production bindings,
// real accounts, email or schedulers are used. The generated access link stays local.
import { randomUUID } from 'node:crypto';
import { mkdir, writeFile, unlink, cp, copyFile, mkdtemp } from 'node:fs/promises';
import { spawn, spawnSync } from 'node:child_process';
import { resolve, join } from 'node:path';
import { tmpdir } from 'node:os';

const directory = resolve('.wrangler/personalized-beta');
const seedFile = resolve(directory, 'local-seed.sql');
const linkFile = resolve(directory, 'manage-url.txt');
const projectDirectory = await mkdtemp(join(tmpdir(),'dialsyria-beta-'));
const wrangler = resolve('node_modules/wrangler/bin/wrangler.js');
const run = (args, cwd=process.cwd()) => {
  const result=spawnSync(process.execPath,args,{cwd,stdio:'inherit',env:{...process.env,WRANGLER_SEND_METRICS:'false',CLOUDFLARE_INCLUDE_PROCESS_ENV:'false',CLOUDFLARE_LOAD_DEV_VARS_FROM_DOT_ENV:'false'}});
  if(result.error) throw result.error;
  if(result.status!==0) throw new Error(`Local setup command failed (exit ${result.status})`);
};

try {
  await mkdir(projectDirectory,{recursive:true});
  await mkdir(directory,{recursive:true});
  // Pages currently loads .dev.vars from its project directory. A separate local
  // project copy ensures the user's existing credentials are never loaded.
  await cp('functions',resolve(projectDirectory,'functions'),{recursive:true});
  await cp('migrations',resolve(projectDirectory,'migrations'),{recursive:true});
  await copyFile('wrangler.toml',resolve(projectDirectory,'wrangler.toml'));
  await writeFile(resolve(projectDirectory,'.dev.vars'),'TELEGRAM_DELIVERY_ENABLED=0\nALLOW_MOCK_DISCOVERY=0\n',{mode:0o600});
  run([resolve('node_modules/typescript/bin/tsc'),'--noEmit']);
  run([resolve('node_modules/vite/bin/vite.js'),'build']);
  // Pages infers its project root from the asset directory, so keep that directory
  // beside the isolated config as well as the isolated functions.
  await cp('dist',resolve(projectDirectory,'dist'),{recursive:true});
  run([wrangler,'d1','execute','dialsyria-db','--local','--persist-to',directory,'--file',resolve('schema.sql')],projectDirectory);
  run([wrangler,'d1','migrations','apply','dialsyria-db','--local','--persist-to',directory,'--force'],projectDirectory);
  const token=randomUUID(), now=new Date().toISOString(), expires=new Date(Date.now()+86400000).toISOString();
  await writeFile(seedFile,`INSERT INTO subscribers (id,email,status,language,created_at,magic_token,magic_expires) VALUES ('local-beta','local-beta@example.invalid','active','ar','${now}','${token}','${expires}') ON CONFLICT(id) DO UPDATE SET magic_token=excluded.magic_token,magic_expires=excluded.magic_expires;\nINSERT OR IGNORE INTO subscriber_topics(subscriber_id,topic) VALUES ('local-beta','politics');\n`,{mode:0o600});
  try { run([wrangler,'d1','execute','dialsyria-db','--local','--persist-to',directory,'--file',seedFile],projectDirectory); }
  finally { await unlink(seedFile); }
  await writeFile(linkFile,`http://127.0.0.1:8788/manage?token=${token}\n`,{mode:0o600});
  console.log(`\nLocal account ready. Open the link stored in ${linkFile} in your browser.`);
  console.log('The link is for the isolated local test account only. Stop the server with Ctrl+C.');
  // Suppress request logs: the legacy local management URL contains a test token.
  const server=spawn(process.execPath,['--use-system-ca',wrangler,'pages','dev',resolve(projectDirectory,'dist'),'--ip','127.0.0.1','--port','8788','--persist-to',directory,'--log-level','error','--binding','TELEGRAM_DELIVERY_ENABLED=0','--binding','ALLOW_MOCK_DISCOVERY=0'],{cwd:projectDirectory,stdio:'inherit',env:{...process.env,WRANGLER_SEND_METRICS:'false',CLOUDFLARE_INCLUDE_PROCESS_ENV:'false',CLOUDFLARE_LOAD_DEV_VARS_FROM_DOT_ENV:'false'}});
  server.on('error',error=>{console.error('Local server failed:',error.message);process.exitCode=1;});
  server.on('exit',code=>{process.exitCode=code ?? 0;});
  process.on('SIGINT',()=>server.kill('SIGINT'));
} catch(error) {console.error('Local setup failed:',error instanceof Error ? error.message : String(error));process.exitCode=1;}
