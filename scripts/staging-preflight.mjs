// Offline only: never executes Wrangler, contacts Cloudflare or reads secrets.
import {readFile} from 'node:fs/promises';
import {resolve} from 'node:path';
import {pathToFileURL} from 'node:url';

export function validateStagingConfig(config,productionToml){
 const errors=[];
 const prodIds=[...productionToml.matchAll(/^\s*database_id\s*=\s*["']([^"']+)["']/gm)].map(x=>x[1].toLowerCase());
 const prodName=productionToml.match(/^\s*name\s*=\s*["']([^"']+)["']/m)?.[1];
 const prodBot=productionToml.match(/^\s*TELEGRAM_BOT\s*=\s*["']([^"']+)["']/m)?.[1];
 if(!prodIds.length || !prodName || !prodBot)errors.push('Production config could not be identified; cannot prove separation.');
 if(!config || typeof config!=='object' || Array.isArray(config))return [...errors,'Invalid config object.'];
 const allowed=new Set(['name','pages_build_output_dir','compatibility_date','d1_databases','vars']);
 if(Object.keys(config).some(key=>!allowed.has(key)))errors.push('Unexpected top-level setting or environment override.');
 if(config.name!=='dialsyria-staging' || config.name===prodName)errors.push('Staging project name is incorrect or matches production.');
 if(config.pages_build_output_dir!=='dist' || config.compatibility_date!=='2026-11-01')errors.push('Unexpected Pages build configuration.');
 if(!Array.isArray(config.d1_databases) || config.d1_databases.length!==1)errors.push('Exactly one D1 binding is required.');
 const db=Array.isArray(config.d1_databases)?config.d1_databases[0]:null;
 if(!db || Object.keys(db).some(key=>!['binding','database_name','database_id','migrations_dir'].includes(key)) || db.binding!=='DB' || db.database_name!=='dialsyria-staging-db' || db.migrations_dir!=='migrations')errors.push('D1 binding/name/migration directory is not the approved staging target.');
 const id=String(db?.database_id || '').toLowerCase();
 if(!/^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/.test(id) || /^0{8}-0{4}-0{4}-0{4}-0{12}$/.test(id))errors.push('A real, nonzero staging D1 UUID is required.');
 if(prodIds.includes(id))errors.push('D1 ID matches production; refusing the staging configuration.');
 const vars=config.vars && typeof config.vars==='object' && !Array.isArray(config.vars)?config.vars:{};
 const keys=['STAGING_PILOT_MODE','STAGING_D1_ID','SITE_URL','TELEGRAM_BOT','TELEGRAM_DELIVERY_ENABLED','ALLOW_MOCK_DISCOVERY','BETA_DURATION_DAYS','BETA_FRESHNESS_HOURS'];
 if(Object.keys(vars).length!==keys.length || Object.keys(vars).some(key=>!keys.includes(key)))errors.push('Unexpected or missing vars; keep secrets and allowlists out of this file.');
 if(vars.STAGING_PILOT_MODE!=='1' || String(vars.STAGING_D1_ID || '').toLowerCase()!==id)errors.push('Staging guard and D1 marker ID must match the binding.');
 if(vars.SITE_URL!=='https://dialsyria-staging.pages.dev')errors.push('SITE_URL must match the isolated HTTPS staging project.');
 if(typeof vars.TELEGRAM_BOT!=='string' || !/^[A-Za-z0-9_]{5,32}$/.test(vars.TELEGRAM_BOT) || vars.TELEGRAM_BOT.toLowerCase()===(prodBot || '').toLowerCase() || vars.TELEGRAM_BOT.includes('REPLACE'))errors.push('A separate dedicated bot username is required.');
 if(vars.TELEGRAM_DELIVERY_ENABLED!=='0' || vars.ALLOW_MOCK_DISCOVERY!=='0')errors.push('Delivery and mock discovery must be disabled in the initial config.');
 if(vars.BETA_DURATION_DAYS!=='14' || vars.BETA_FRESHNESS_HOURS!=='72')errors.push('Unexpected trial or freshness setting.');
 return errors;
}

async function main(){
 try{
  const config=JSON.parse(await readFile(resolve(process.argv[2] || 'wrangler.staging.local.json'),'utf8'));
  const production=await readFile(resolve('wrangler.toml'),'utf8');
  const errors=validateStagingConfig(config,production);
  if(errors.length){for(const error of errors)console.error(`BLOCKED: ${error}`);process.exitCode=1;return;}
  console.log('Local configuration passed. Remote project, D1 binding, bot credentials and webhook have NOT been checked. No remote action was performed.');
 }catch{console.error('BLOCKED: local staging or production configuration is missing or invalid.');process.exitCode=1;}
}
if(process.argv[1] && import.meta.url===pathToFileURL(resolve(process.argv[1])).href)await main();
