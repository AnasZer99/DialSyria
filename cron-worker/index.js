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

    if (event.cron === "0 1 * * *") {
      // Daily RSS ingestion at 01:00 UTC = 04:00 Damascus (UTC+3, no DST).
      // The ingest route refuses a second clean run for the same Damascus day.
      ctx.waitUntil(ping(base + "/api/ingest", { method: "POST", headers }));
       } else if (event.cron === "7 * * * *") {
      ctx.waitUntil(
        ping(base + "/api/digest", {
          method: "POST",
          headers
        })
      );
    }
  },
};