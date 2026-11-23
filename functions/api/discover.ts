import { checkAdmin, checkCronSecret, fail, json, readJson, type Env, type Handler } from './_lib';
import { runDiscovery, type Database } from './_discovery';

// Explicit protected operation; discovery is never launched by a public visitor.
export const onRequestPost: Handler<Env & { BRAVE_SEARCH_API_KEY?: string }> = async ({request, env}) => {
  if (!env.DB) return fail('database not bound', 500);
  if (!checkCronSecret(request,env) && !(await checkAdmin(request,env))) return fail('unauthorized',401);
  const body = await readJson<{interest?: unknown; use_brave?: boolean}>(request);
  if (typeof body.interest !== 'string' || body.interest.trim().length < 3 || body.interest.trim().length > 300) return fail('interest must be 3-300 characters');
  if (body.use_brave && !env.BRAVE_SEARCH_API_KEY) return fail('BRAVE_SEARCH_API_KEY not configured',503);
  try { return json(await runDiscovery(env.DB as unknown as Database,body.interest,{key:body.use_brave ? env.BRAVE_SEARCH_API_KEY : undefined})); }
  catch (e) { console.error('discovery failure', e); return fail('discovery failed; check server logs and migrations',500); }
};
