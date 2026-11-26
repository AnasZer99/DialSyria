import { fail, json, nowISO, uuid, type Handler } from '../_lib';
import { owner } from '../interests';

// Short-lived, single-use Telegram linking tokens. The management token authenticates
// this request but is never placed in a deep link or sent to Telegram.
const LINK_TTL_MS = 15 * 60 * 1000;

export const onRequestPost: Handler = async ({ request, env }) => {
  if (!env.DB) return fail('database not bound', 500);
  // Beta identities are already linked; only legacy bearer sessions may request
  // a link token, so a beta cookie cannot silently relink an account.
  if (!(request.headers.get('authorization') || '').startsWith('Bearer ')) return fail('invalid or expired token', 401);
  const subscriberId = await owner(request, env, true);
  if (!subscriberId) return fail('invalid or expired token', 401);
  const now = nowISO();
  const expires = new Date(Date.now() + LINK_TTL_MS).toISOString();
  const token = uuid();
  // Revoke any previous unused tokens by expiring them (never delete).
  await env.DB.prepare('UPDATE telegram_link_tokens SET expires_at=? WHERE subscriber_id=? AND used_at IS NULL').bind(now, subscriberId).run();
  await env.DB.prepare('INSERT INTO telegram_link_tokens (token,subscriber_id,created_at,expires_at) VALUES (?,?,?,?)').bind(token, subscriberId, now, expires).run();
  return json({ token, expires_at: expires });
};
