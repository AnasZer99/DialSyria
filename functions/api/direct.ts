import { checkAdmin, checkCronSecret, fail, json, readJson, type Env, type Handler } from './_lib';
import { discoverDirectSources, monitorDirectSources } from './_direct';
import type { Database } from './_discovery';
import { runInterestSweep } from './_interest_monitor';

export const onRequestPost: Handler<Env & {BRAVE_SEARCH_API_KEY?:string}> = async ({request,env}) => {
  if (!env.DB) return fail('database not bound',500);
  if (!checkCronSecret(request,env) && !(await checkAdmin(request,env))) return fail('unauthorized',401);
  const body=await readJson<{mode?:string; interest?:string; use_brave?:boolean}>(request);
  const db=env.DB as unknown as Database;
  try {
    if(body.mode==='sweep') {
      return json(await runInterestSweep(db,env));
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
