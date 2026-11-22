import { Env, Handler, fail, json, checkCronSecret, checkAdmin } from "./_lib";
import { runDigest } from "./_digest";

export const onRequestPost: Handler = async ({ request, env }) => {
  if (!env.DB) return fail("database not bound", 500);
  if (!checkCronSecret(request, env) && !(await checkAdmin(request, env))) {
    return fail("unauthorized", 401);
  }
  // ?all=1: بث فوري لجميع المشتركين المفعّلين بغض النظر عن ساعتهم المحددة
  const broadcast = new URL(request.url).searchParams.get("all") === "1";
  const result = await runDigest(env, broadcast);
  return json(result);
};
