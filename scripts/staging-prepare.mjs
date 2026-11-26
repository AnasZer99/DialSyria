// Build a reviewable isolated Pages directory. No remote commands are run.
import {cp,mkdir,mkdtemp,readFile,writeFile} from 'node:fs/promises';
import {resolve,join} from 'node:path';
import {validateStagingConfig} from './staging-preflight.mjs';
try{
 const cfg=JSON.parse(await readFile('wrangler.staging.local.json','utf8'));
 const errors=validateStagingConfig(cfg,await readFile('wrangler.toml','utf8'));
 if(errors.length)throw Error(errors.join(' '));
 // Require a successful local build before staging preparation.
 await readFile('dist/index.html');
 await mkdir('.wrangler',{recursive:true});
 const dir=await mkdtemp(join(resolve('.wrangler'),'staging-pilot-'));
 for(const entry of ['functions','migrations','dist'])await cp(resolve(entry),join(dir,entry),{recursive:true});
 await cp(resolve('schema.sql'),join(dir,'schema.sql'));
 await writeFile(join(dir,'wrangler.json'),JSON.stringify(cfg,null,2)+'\n',{mode:0o600});
 const markerId=cfg.d1_databases[0].database_id.toLowerCase(); // Already validated as a UUID.
 await writeFile(join(dir,'staging-marker.sql'),`INSERT OR IGNORE INTO rate_limits(key,window,count) VALUES('staging-db:${markerId}','staging-only',1);\n`,{mode:0o600});
 console.log(`Isolated staging files prepared in ${dir}`);
 console.log('No environment files copied, no remote binding verified, and no remote action performed.');
}catch(error){console.error(`BLOCKED: ${error instanceof Error?error.message:'staging preparation failed'}`);process.exitCode=1;}
