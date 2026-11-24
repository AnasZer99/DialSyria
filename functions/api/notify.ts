import { checkAdmin, checkCronSecret, fail, json, readJson, type Env, type Handler } from './_lib';
import { createMockTelegramTransport, createTelegramTransport, runPreparation, type DeliveryTransport } from './_notify';
import type { Database } from './_discovery';

// Protected workflow: prepares personalized previews and, only behind the explicit
// server-side TELEGRAM_DELIVERY_ENABLED flag plus the TELEGRAM_TEST_CHAT_IDS allowlist,
// delivers them through the real Bot API transport. `simulate` renders through the
// in-memory mock transport without persisting any delivery status and never contacts
// Telegram.
export const onRequestPost: Handler<Env> = async ({ request, env }) => {
  if (!env.DB) return fail('database not bound', 500);
  if (!checkCronSecret(request, env) && !(await checkAdmin(request, env))) return fail('unauthorized', 401);
  const body = await readJson<{ subscriber_id?: unknown; simulate?: unknown; mode?: unknown } | null>(request);
  const subscriberId = body && typeof body.subscriber_id === 'string' && body.subscriber_id ? body.subscriber_id : undefined;
  const simulate = !!(body && body.simulate === true);
  const mode = body && body.mode === 'deliver' ? 'deliver' : 'prepare';
  const deliveryEnabled = env.TELEGRAM_DELIVERY_ENABLED === '1';
  const testRecipients = new Set((env.TELEGRAM_TEST_CHAT_IDS || '').split(/[\s,]+/).map((s) => s.trim()).filter(Boolean));

  let transportFor: ((subscriberId: string) => DeliveryTransport | undefined) | undefined;
  if (simulate) {
    const mock = createMockTelegramTransport();
    transportFor = () => mock;
  } else if (mode === 'deliver' && deliveryEnabled) {
    // Real delivery is restricted to explicitly allowlisted chat IDs only.
    const chats = await env.DB.prepare('SELECT id, telegram_chat_id FROM subscribers WHERE telegram_chat_id IS NOT NULL').bind().all<{ id: string; telegram_chat_id: string }>();
    const bySubscriber = new Map(
      chats.results
        .filter((row) => testRecipients.has(row.telegram_chat_id))
        .map((row) => [row.id, createTelegramTransport(env, row.telegram_chat_id)])
    );
    transportFor = (id) => bySubscriber.get(id);
  }

  const result = await runPreparation(env.DB as unknown as Database, {
    subscriberId,
    transportFor,
    persist: simulate ? false : undefined,
  });
  return json({ ...result, mode, deliveryEnabled, testRecipientCount: testRecipients.size, simulated: simulate });
};
