
import {
  type Env,
  fail,
  stagingAllowlistsValid,
} from "./api/_lib";

// Production database must never be used by Staging.
const productionDatabaseId =
  "44b3a09f-8f64-4ea0-81e1-d79bc4af7575";

const stagingSiteUrl =
  "https://dialsyria-staging.pages.dev";

// Verify the staging database isolation marker.
async function stagingDatabaseVerified(
  env: Env
): Promise<Response | null> {
  const id = (env.STAGING_D1_ID || "").toLowerCase();

  const validId =
    /^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/.test(id);

  if (!env.DB || !validId || id === productionDatabaseId) {
    return fail("staging database isolation not verified", 503);
  }

  try {
    const marker = await env.DB
      .prepare(
        "SELECT count FROM rate_limits WHERE key = ? AND window = ?"
      )
      .bind(`staging-db:${id}`, "staging-only")
      .first<{ count: number }>();

    if (marker?.count === 1) {
      return null;
    }

    return fail("staging database isolation not verified", 503);
  } catch {
    return fail("staging database isolation not verified", 503);
  }
}

export async function onRequest({
  request,
  env,
  next,
}: {
  request: Request;
  env: Env;
  next: () => Promise<Response>;
}): Promise<Response> {
  const url = new URL(request.url);

  const stagingHost =
    url.hostname === "dialsyria-staging.pages.dev" ||
    url.hostname.endsWith(".dialsyria-staging.pages.dev");

  // ==========================================
  // RSS-ONLY STAGING MODE
  // ==========================================

  if (env.RSS_STAGING_MODE === "1") {
    // Never enable RSS staging mode on other hosts.
    if (!stagingHost) {
      return fail(
        "rss staging mode is restricted to dialsyria-staging.pages.dev",
        503
      );
    }

    // Required staging security configuration.
    const validConfiguration =
      env.STAGING_PILOT_MODE === "1" &&
      env.SITE_URL === stagingSiteUrl &&
      env.ALLOW_MOCK_DISCOVERY === "0" &&
      env.TELEGRAM_DELIVERY_ENABLED === "0" &&
      env.BETA_SCHEDULED_DELIVERY_ENABLED === "0";

    if (!validConfiguration) {
      return fail(
        "rss staging protection is not configured",
        503
      );
    }

    // Verify isolated D1 database.
    const databaseError =
      await stagingDatabaseVerified(env);

    if (databaseError) {
      return databaseError;
    }

    // Allow only RSS MVP API endpoints.
    if (
      url.pathname === "/api" ||
      url.pathname.startsWith("/api/")
    ) {
      const allowed =
        (request.method === "GET" &&
          url.pathname === "/api/news") ||
        (request.method === "POST" &&
          (url.pathname === "/api/ingest" ||
            url.pathname === "/api/digest"));

      if (!allowed) {
        return fail(
          "route not available in rss staging mode",
          404
        );
      }
    }

    return next();
  }

  // ==========================================
  // LEGACY BETA STAGING PROTECTION
  // ==========================================

  if (stagingHost && env.STAGING_PILOT_MODE !== "1") {
    return fail(
      "staging protection is not configured",
      503
    );
  }

  if (env.STAGING_PILOT_MODE !== "1") {
    return next();
  }

  const validBetaConfiguration =
    stagingHost &&
    env.SITE_URL === stagingSiteUrl &&
    env.ALLOW_MOCK_DISCOVERY === "0" &&
    ["0", "1"].includes(
      env.TELEGRAM_DELIVERY_ENABLED || ""
    ) &&
    stagingAllowlistsValid(env);

  if (!validBetaConfiguration) {
    return fail(
      "staging protection is not configured",
      503
    );
  }

  const validTelegramBot =
    /^[A-Za-z0-9_]{5,32}$/.test(
      env.TELEGRAM_BOT || ""
    ) &&
    (env.TELEGRAM_BOT || "").toLowerCase() !==
      "dialsyriabot";

  const validTelegramToken =
    /^\d{6,15}:[A-Za-z0-9_-]{30,}$/.test(
      env.TELEGRAM_BOT_TOKEN || ""
    );

  const validWebhookSecret =
    /^[A-Za-z0-9_-]{32,256}$/.test(
      env.TELEGRAM_WEBHOOK_SECRET || ""
    );

  const validAdminPassword =
    (env.ADMIN_PASSWORD || "").length >= 24;

  if (
    !validTelegramBot ||
    !validTelegramToken ||
    !validWebhookSecret ||
    !validAdminPassword
  ) {
    return fail(
      "staging protection is not configured",
      503
    );
  }

  // Block legacy token-based access in Staging.
  const legacyBlockedRoute =
    /^\/api\/(?:subscribe|login|me|telegram\/link)\/?$/.test(
      url.pathname
    );

  if (
    url.searchParams.has("token") ||
    legacyBlockedRoute
  ) {
    return fail(
      "legacy token access disabled on staging",
      403
    );
  }

  // Verify database isolation for legacy Beta too.
  const databaseError =
    await stagingDatabaseVerified(env);

  if (databaseError) {
    return databaseError;
  }

  return next();
}
