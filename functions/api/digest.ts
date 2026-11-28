import { Env, Handler, fail, json, checkCronSecret, checkAdmin } from "./_lib";
import { runDigest } from "./_digest";
import { runMvpDigest } from "./_rss_mvp";

export const onRequestPost: Handler = async ({ request, env }) => {
  if (!env.DB) return fail("database not bound", 500);
  if (!checkCronSecret(request, env) && !(await checkAdmin(request, env))) {
    return fail("unauthorized", 401);
  }
  // ?all=1: بث فوري لجميع المشتركين المفعّلين بغض النظر عن ساعتهم المحددة
  const broadcast = new URL(request.url).searchParams.get("all") === "1";
  const result = await runDigest(env, broadcast);
  // RSS MVP pass: Telegram digest for admin-approved subscribers, from stored
  // articles only. Runs only when RSS_MVP_MODE is explicitly enabled.
  const mvp = env.RSS_MVP_MODE === "1" ? await runMvpDigest(env) : null;
  return json({ ...result, mvp });
};
