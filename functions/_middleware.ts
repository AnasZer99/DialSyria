import { type Env, fail, stagingAllowlistsValid } from './api/_lib';

// The marker is installed only after the operator independently verifies the
// staging database. Requests never create it. D1 does not expose its bound UUID
// to a Worker; remote binding verification is still required before migration.
const productionDatabaseId='44b3a09f-8f64-4ea0-81e1-d79bc4af7575';
export async function onRequest({request,env,next}:{request:Request;env:Env;next:()=>Promise<Response>}):Promise<Response>{
  const url=new URL(request.url);
  const stagingHost=url.hostname==='dialsyria-staging.pages.dev' || url.hostname.endsWith('.dialsyria-staging.pages.dev');
  if(stagingHost && env.STAGING_PILOT_MODE!=='1')return fail('staging protection is not configured',503);
  if(env.STAGING_PILOT_MODE!=='1')return next();
  if(!stagingHost || env.SITE_URL!=='https://dialsyria-staging.pages.dev' || env.ALLOW_MOCK_DISCOVERY!=='0' || !['0','1'].includes(env.TELEGRAM_DELIVERY_ENABLED || '') || !stagingAllowlistsValid(env))return fail('staging protection is not configured',503);
  if(!/^[A-Za-z0-9_]{5,32}$/.test(env.TELEGRAM_BOT || '') || (env.TELEGRAM_BOT || '').toLowerCase()==='dialsyriabot' || !/^\d{6,15}:[A-Za-z0-9_-]{30,}$/.test(env.TELEGRAM_BOT_TOKEN || '') || !/^[A-Za-z0-9_-]{32,256}$/.test(env.TELEGRAM_WEBHOOK_SECRET || '') || (env.ADMIN_PASSWORD || '').length<24)return fail('staging protection is not configured',503);
  // The staging pilot must not issue or accept legacy management tokens in URLs.
  if(url.searchParams.has('token') || /^\/api\/(?:subscribe|login|me|telegram\/link)\/?$/.test(url.pathname))return fail('legacy token access disabled on staging',403);
  const id=(env.STAGING_D1_ID || '').toLowerCase();
  if(!env.DB || !/^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/.test(id) || id===productionDatabaseId)return fail('staging database isolation not verified',503);
  try{
    const marker=await env.DB.prepare('SELECT count FROM rate_limits WHERE key=? AND window=?').bind('staging-db:'+id,'staging-only').first<{count:number}>();
    return marker?.count===1?next():fail('staging database isolation not verified',503);
  }catch{return fail('staging database isolation not verified',503);}
}
