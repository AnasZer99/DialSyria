import { fail, json, readJson, type Handler } from '../_lib';
import { runDiscovery, type Database } from '../_discovery';
import { owner } from '../interests';

// Subscriber-triggered discovery for one saved interest. Mock mode only for now:
// deterministic sample data, no live search activation, no credentials required.
// The interest text is loaded from the database for the authenticated owner and
// is never taken from the request body.
export const onRequestPost: Handler = async ({ request, env }) => {
  if (!env.DB) return fail('database not bound', 500);
  if (env.ALLOW_MOCK_DISCOVERY !== '1') return fail('mock discovery is disabled', 403);
  const subscriberId = await owner(request, env, true);
  if (!subscriberId) return fail('invalid or expired token', 401);
  const body = await readJson<{ id?: unknown } | null>(request);
  if (!body || typeof body.id !== 'string' || !body.id) return fail('missing interest id');
  const interest = await env.DB.prepare('SELECT text FROM subscriber_interests WHERE id=? AND subscriber_id=?').bind(body.id, subscriberId).first<{ text: string }>();
  if (!interest) return fail('interest not found', 404);
  try {
    const report = await runDiscovery(env.DB as unknown as Database, interest.text, { mock: true });
    return json({ interestId: body.id, report });
  } catch (e) {
    console.error('interest discovery failure', e);
    return fail('discovery failed; check server logs and migrations', 500);
  }
};
