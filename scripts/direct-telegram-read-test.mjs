import {loadDirect} from './discovery-runtime.mjs';
import {build} from 'esbuild';
import {pathToFileURL} from 'node:url';
import {resolve} from 'node:path';
const engine=await loadDirect();
await build({entryPoints:['functions/api/_publisher.ts'],bundle:true,platform:'neutral',format:'esm',outfile:'.wrangler/discovery/publisher-probe.mjs'});
const {allowedByRobots}=await import(pathToFileURL(resolve('.wrangler/discovery/publisher-probe.mjs')).href);
const robots=await fetch('https://t.me/robots.txt',{redirect:'manual',signal:AbortSignal.timeout(10000)});
if(robots.status!==404 && (!robots.ok || !allowedByRobots(await robots.text(),'/s/SyriaDefence/64615'))) {console.log(JSON.stringify({status:'robots_denied_or_unavailable'}));process.exit(0);}
const r=await fetch('https://t.me/s/SyriaDefence/64615',{redirect:'manual',signal:AbortSignal.timeout(10000)});
const posts=engine.parseTelegram(await r.text(),'https://t.me/s/SyriaDefence');
console.log(JSON.stringify({status:r.status,count:posts.length,posts:posts.filter(x=>x.url.endsWith('/64615')).map(x=>({url:x.url,publishedAt:x.publishedAt,text:x.text.slice(0,200)}))},null,2));
