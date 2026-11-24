# DialSyria project guide

DialSyria is a Syria-focused personal information and news discovery service. It combines a legacy news digest with experimental discovery and direct-source monitoring.

- Stack: React, TypeScript and Vite; Cloudflare Pages Functions, D1 and a scheduled Worker; Telegram and Brevo integrations.
- Key code: `functions/api/interests.ts` manages subscriber interests; `_discovery.ts` and `_direct.ts` implement discovery and source monitoring; `_digest.ts` handles the legacy digest; `cron-worker/` schedules jobs; `migrations/` contains additive SQL.
- Use Node 22.13+ or a compatible newer version: local tests use `node:sqlite`. Install dependencies using the existing lockfile. Do not overwrite unrelated work or the user's pre-existing lockfile changes.
- Checks: `npm test`, `npm run build`, `npm run typecheck:backend`. Wrangler generates ignored `worker-configuration.d.ts` for backend checking. Tests use isolated SQLite and mocked external services.
- Never expose access tokens or secrets; subscriber operations must derive the owner from an authenticated token. Never mutate an account merely from an email address. Do not deploy, push, purchase services, or apply remote database changes without authorization.
- Database migrations must be additive and tested against isolated data. Before applying to a real database, verify a backup and a recovery plan; removing a new table would discard data subsequently written to it.
- Personal interests are not yet connected to discovery or delivery. Brave and Telegram discovery have not been verified live. The existing Telegram account-link flow reuses a management token and requires a separate security fix.
