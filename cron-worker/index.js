// DialSyria cron worker — Pages has no cron triggers, so this tiny worker
// pings the Pages Functions on a schedule. Free plan, zero request cost.
// Deploy: cd cron-worker && wrangler secret put CRON_SECRET && wrangler deploy

export default {
  async scheduled(event, env, ctx) {
    const base = (env.SITE_URL || "https://dial-syria.pages.dev").replace(/\/$/, "");
    const headers = { "x-cron-secret": env.CRON_SECRET || "" };

    if (event.cron === "*/30 * * * *") {
      // ingestion: gather + classify fresh news every 30 minutes
      ctx.waitUntil(fetch(base + "/api/ingest", { method: "POST", headers }));
      ctx.waitUntil(fetch(base + "/api/direct", { method: "POST", headers: { ...headers, "content-type": "application/json" }, body: JSON.stringify({ mode: "sweep" }) }));
    } else if (event.cron === "7 * * * *") {
      // digests: at minute :07 of every hour, send to subscribers whose
      // chosen Damascus hour matches the current hour
      ctx.waitUntil(fetch(base + "/api/digest", { method: "POST", headers }));
    }
  },
};
