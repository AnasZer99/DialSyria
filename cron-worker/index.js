// DialSyria cron worker — Pages has no cron triggers, so this tiny worker
// pings the Pages Functions on a schedule. Free plan, zero request cost.
// Deploy: cd cron-worker && wrangler secret put CRON_SECRET && wrangler deploy

// Fire a scheduled call and surface non-success responses and network errors in the
// logs without exposing the cron secret or any request body.
async function ping(url, init) {
  try {
    const res = await fetch(url, init);
    if (!res.ok) console.error(`scheduled call failed: ${res.status} ${url}`);
  } catch (err) {
    console.error(`scheduled call failed: network error ${url}`, err && err.message ? err.message : err);
  }
}

export default {
  async scheduled(event, env, ctx) {
    const base = (env.SITE_URL || "https://dial-syria.pages.dev").replace(/\/$/, "");
    const headers = { "x-cron-secret": env.CRON_SECRET || "" };

    if (event.cron === "*/30 * * * *") {
      // ingestion: gather + classify fresh news every 30 minutes
      ctx.waitUntil(ping(base + "/api/ingest", { method: "POST", headers }));
      ctx.waitUntil(ping(base + "/api/direct", { method: "POST", headers: { ...headers, "content-type": "application/json" }, body: JSON.stringify({ mode: "sweep" }) }));
    } else if (event.cron === "7 * * * *") {
      // digests: at minute :07 of every hour, send to subscribers whose
      // chosen Damascus hour matches the current hour
      ctx.waitUntil(ping(base + "/api/digest", { method: "POST", headers }));
      // personalized notifications: prepare each run; real delivery is gated behind
      // TELEGRAM_DELIVERY_ENABLED and the test-recipient allowlist on the Pages side.
      ctx.waitUntil(ping(base + "/api/notify", { method: "POST", headers: { ...headers, "content-type": "application/json" }, body: JSON.stringify({ mode: "deliver" }) }));
    }
  },
};
