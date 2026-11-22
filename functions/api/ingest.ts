import { Env, Handler, fail, json, checkCronSecret, checkAdmin } from "./_lib";
import { runIngestion } from "./_ingest";

export const onRequestPost: Handler = async ({ request, env }) => {
  if (!env.DB) return fail("database not bound", 500);
  if (!checkCronSecret(request, env) && !(await checkAdmin(request, env))) {
    return fail("unauthorized", 401);
  }
  const result = await runIngestion(env);
  return json(result);
};
