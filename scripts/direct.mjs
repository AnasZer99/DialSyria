import {loadDirect,openDatabase} from './discovery-runtime.mjs';
const [mode,...words]=process.argv.slice(2);const interest=words.join(' ').trim();
if(!['discovery','monitor'].includes(mode)||!interest){console.error('Usage: node scripts/direct.mjs discovery|monitor "interest"');process.exit(1);}
const engine=await loadDirect();const {db,sqlite}=await openDatabase('.wrangler/discovery/direct-local.sqlite');
try {const result=mode==='discovery'?await engine.discoverDirectSources(db,interest):await engine.monitorDirectSources(db,interest);console.log(JSON.stringify(result,null,2));}finally{sqlite.close();}
