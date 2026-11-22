import { Env, Handler, fail, json, readJson, makeAdminToken, clientIp, rateLimit } from "../_lib";

function constantEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let r = 0;
  for (let i = 0; i < a.length; i++) r |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return r === 0;
}

export const onRequestPost: Handler = async ({ request, env }) => {
  if (!env.ADMIN_PASSWORD) return fail("ADMIN_PASSWORD not configured", 500);
  if (!(await rateLimit(env, "admin:" + clientIp(request), 5))) return fail("too many attempts, try again next hour", 429);
  const { password } = await readJson<{ password?: string }>(request);
  if (typeof password !== "string" || !constantEqual(password, env.ADMIN_PASSWORD)) {
    return fail("wrong password", 401);
  }
  return json({ token: await makeAdminToken(env) });
};
