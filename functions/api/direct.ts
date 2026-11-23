import { checkAdmin, checkCronSecret, fail, json, readJson, type Env, type Handler } from './_lib';
import { discoverDirectSources, monitorDirectSources } from './_direct';
import type { Database } from './_discovery';

export const onRequestPost: Handler<Env & {BRAVE_SEARCH_API_KEY?:string}> = async ({request,env}) => {
  if (!env.DB) return fail('database not bound',500);
  if (!checkCronSecret(request,env) && !(await checkAdmin(request,env))) return fail('unauthorized',401);
  const body=await readJson<{mode?:string; interest?:string; use_brave?:boolean}>(request);
  const db=env.DB as unknown as Database;
  try {
    if(body.mode==='sweep') {
      const cutoff=new Date(Date.now()-30*60*1000).toISOString();
      const row=await db.prepare('SELECT i.interest_key FROM direct_source_interests i WHERE i.last_checked_at IS NULL OR i.last_checked_at<? ORDER BY i.last_checked_at LIMIT 1').bind(cutoff).first<{interest_key:string}>();
      if(!row)return json({mode:'sweep',checked:0});
      const monitor=await monitorDirectSources(db,row.interest_key);
      const last=await db.prepare("SELECT started_at FROM direct_runs WHERE interest_key=? AND mode='discovery' ORDER BY started_at DESC LIMIT 1").bind(row.interest_key).first<{started_at:string}>();
      const discovery=!last || Date.now()-Date.parse(last.started_at)>24*3600000 ? await discoverDirectSources(db,row.interest_key) : null;
      return json({mode:'sweep',checked:1,monitor,discovery});
    }
    if(typeof body.interest!=='string' || body.interest.trim().length<3 || body.interest.length>300)return fail('invalid interest');
    if(body.mode==='monitor')return json(await monitorDirectSources(db,body.interest));
    if(body.mode==='discovery') {
      if(body.use_brave && !env.BRAVE_SEARCH_API_KEY)return fail('BRAVE_SEARCH_API_KEY not configured',503);
      return json(await discoverDirectSources(db,body.interest,{key:body.use_brave ? env.BRAVE_SEARCH_API_KEY : undefined}));
    }
    return fail('mode must be discovery, monitor, or sweep');
  } catch(e) {console.error('direct source failure',e);return fail('direct source operation failed; check migrations and logs',500);}
};
