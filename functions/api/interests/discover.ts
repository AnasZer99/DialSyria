import { fail, json, readJson, type Handler } from '../_lib';
import { runDiscovery, type Database } from '../_discovery';
import { runLiveInterest } from '../_live_interest';
import { owner } from '../interests';

// Subscriber identity and the interest text always come from authenticated storage.
export const onRequestPost: Handler = async ({ request, env }) => {
  if (!env.DB) return fail('database not bound', 500);
  const subscriberId = await owner(request, env, true);
  if (!subscriberId) return fail('invalid or expired token', 401);
  const body = await readJson<{ id?: unknown; mode?: unknown } | null>(request);
  if (!body || typeof body.id !== 'string' || !body.id) return fail('missing interest id');
  const mode = body.mode === undefined ? 'mock' : body.mode;
  if (mode !== 'mock' && mode !== 'live') return fail('invalid discovery mode');
  if (mode === 'mock' && env.ALLOW_MOCK_DISCOVERY !== '1') return fail('mock discovery is disabled', 403);
  const interest = await env.DB.prepare('SELECT text FROM subscriber_interests WHERE id=? AND subscriber_id=?').bind(body.id, subscriberId).first<{ text: string }>();
  if (!interest) return fail('interest not found', 404);
  try {
    if (mode === 'live') {
      // Atomic hourly caps bound abuse even when requests arrive concurrently.
      const window = new Date().toISOString().slice(0, 13);
      for (const [key, limit] of [[`live-discovery:subscriber:${subscriberId}:${window}`, 3], [`live-discovery:global:${window}`, 30]] as const) {
        const slot = await env.DB.prepare('INSERT INTO rate_limits (key,window,count) VALUES (?,?,1) ON CONFLICT(key) DO UPDATE SET count=count+1 WHERE count<? RETURNING count')
          .bind(key, window, limit).first<{count:number}>();
        if (!slot) return fail('live discovery rate limit reached; try later', 429);
      }
      const report = await runLiveInterest(env.DB as unknown as Database, interest.text);
      return json({ interestId:body.id, ...report });
    }
    const report = await runDiscovery(env.DB as unknown as Database, interest.text, { mock: true });
    return json({ interestId: body.id, report });
  } catch (e) {
    console.error('interest discovery failure', e);
    return fail('discovery failed; check server logs and migrations', 500);
  }
};
