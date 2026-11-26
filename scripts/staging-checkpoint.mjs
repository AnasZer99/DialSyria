// Review manifest only: no git add, commit, push or changes to the index.
import {execFileSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import {readFile,writeFile} from 'node:fs/promises';
import {resolve} from 'node:path';
try{
 const cwd=process.cwd(),safe=`safe.directory=${cwd.replaceAll('\\','/')}`;
 const git=(...args)=>execFileSync('git',['-c',safe,...args],{cwd,encoding:'utf8'});
 if(git('diff','--cached','--name-only','-z'))throw Error('The Git index is not empty; review it before preparing a checkpoint.');
 const tracked=git('diff','--name-only','-z').split('\0').filter(Boolean);
 const untracked=git('ls-files','--others','--exclude-standard','-z').split('\0').filter(Boolean);
 const roots=new Set(['.gitignore','DISCOVERY_REPORT.md','README.md','STAGING_PILOT_REPORT.md','package.json','wrangler.staging.example.json']);
 const valid=p=>roots.has(p) || /^(?:functions|src|scripts|migrations|tests)\/[A-Za-z0-9_./-]+\.(?:ts|tsx|css|mjs|sql)$/.test(p);
 const names=[...new Set([...tracked,...untracked])].filter(valid).sort();
 const files=[];for(const path of names){const data=await readFile(resolve(path));files.push({path,sha256:createHash('sha256').update(data).digest('hex')});}
 const report={kind:'local-review-manifest-not-a-commit',baseCommit:git('rev-parse','HEAD').trim(),excludedExisting:['package-lock.json','opencode.jsonc'],files};
 await writeFile('STAGING_CHECKPOINT.json',JSON.stringify(report,null,2)+'\n','utf8');
 console.log(`Review manifest created for ${files.length} files; Git index unchanged. Re-run after any edit.`);
}catch(error){console.error(`BLOCKED: ${error instanceof Error?error.message:'checkpoint failed'}`);process.exitCode=1;}
