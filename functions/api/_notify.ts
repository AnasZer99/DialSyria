import { nowISO, tgSendLong, uuid, type Env } from './_lib';
import { evaluate, normalize, type Database } from './_discovery';

// Notification preparation and (simulated) delivery for personal interests.
// No real Telegram/email calls happen in this module: delivery goes through an
// injectable transport, and the only transport provided here is an in-memory mock.
//
// Rules:
// - discovery_items are candidates only when linked to one of the subscriber's exact
//   interest keys (the engine's acceptance record), non-mock, and publisher-verified;
// - direct_items are candidates only when re-evaluated against the subscriber's actual
//   interest text (a post from a linked source is not automatically relevant);
// - mock/test domains and news.google.com URLs are never delivered;
// - one notification per subscriber per canonical URL, across both stores;
// - prepared -> sent/failed transitions; sent is terminal and only set after delivery.

export type NotificationKind = 'discovery' | 'direct';

export interface NotificationItem {
  id: string;
  kind: NotificationKind;
  itemId: string;
  title: string;
  source: string | null;
  publishedAt: string | null;
  excerpt: string | null;
  url: string;
  interestKey: string;
}

export interface PreparedNotification {
  subscriberId: string;
  items: NotificationItem[];
  text: string;
}

export interface DeliveryTransport {
  send(text: string): Promise<{ ok: boolean; error?: string }>;
}

export interface DeliveryResult {
  subscriberId: string;
  sent: number;
  failed: number;
  messages: string[];
}

export interface PreparationSummary {
  dryRun: boolean;
  subscribers: number;
  prepared: number;
  sent: number;
  failed: number;
  details: { subscriberId: string; prepared: number; delivered: 'prepared' | 'sent' | 'failed' | 'no_items' }[];
  messages: string[];
}

const MAX_ITEMS = 3;
const MAX_EXCERPT = 180;
const DAY_RE = /^\d{4}-\d{2}-\d{2}/;

function excerptOf(raw: string | null | undefined): string | null {
  if (!raw) return null;
  const s = raw.replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim();
  if (!s) return null;
  if (s.length <= MAX_EXCERPT) return s;
  return s.slice(0, MAX_EXCERPT).replace(/\s+\S*$/, '') + '…';
}

function dayOf(value: string | null): string | null {
  return value && DAY_RE.test(value) ? value.slice(0, 10) : null;
}

export function canonicalUrl(raw: string): string {
  try {
    const u = new URL(raw);
    u.hash = '';
    for (const key of [...u.searchParams.keys()]) if (/^(utm_|fbclid|gclid)/i.test(key)) u.searchParams.delete(key);
    u.hostname = u.hostname.toLowerCase();
    return u.toString();
  } catch {
    return raw;
  }
}

function blockedHost(raw: string): boolean {
  try {
    const h = new URL(raw).hostname.toLowerCase();
    return h === 'news.google.com' || h.endsWith('.test');
  } catch {
    return true;
  }
}

export function renderNotificationText(items: NotificationItem[], lang: 'ar' | 'en' = 'ar'): string {
  if (!items.length) return '';
  const header = lang === 'ar' ? 'تحديثات حسب اهتماماتك:' : 'Updates matching your interests:';
  const parts = items.map((item) => {
    const meta = [item.source, dayOf(item.publishedAt)].filter((x): x is string => !!x).join(' · ');
    return [`■ ${item.title}`, ...(meta ? [meta] : []), ...(item.excerpt ? [item.excerpt] : []), item.url].join('\n');
  });
  return [header, ...parts].join('\n\n');
}

interface DiscoveryRow {
  id: string;
  title: string;
  description: string | null;
  source: string | null;
  url: string;
  original_url: string | null;
  publisher_published_at: string | null;
  published_at: string | null;
  verification_status: string | null;
  interest_key: string;
}

interface DirectRow {
  id: string;
  title: string;
  content: string | null;
  url: string;
  published_at: string | null;
  source: string;
  interest_key: string;
}

interface Candidate {
  kind: NotificationKind;
  itemId: string;
  title: string;
  description: string | null;
  source: string | null;
  publishedAt: string | null;
  url: string;
  interestKey: string;
}

export async function prepareNotifications(
  db: Database,
  subscriberId: string,
  opts: { limit?: number; lang?: 'ar' | 'en' } = {}
): Promise<PreparedNotification> {
  const limit = Math.max(1, Math.min(opts.limit ?? MAX_ITEMS, MAX_ITEMS));
  const empty: PreparedNotification = { subscriberId, items: [], text: '' };

  const interests = await db.prepare('SELECT text FROM subscriber_interests WHERE subscriber_id=?').bind(subscriberId).all<{ text: string }>();
  const keyToText = new Map<string, string>();
  for (const row of interests.results) {
    const key = normalize(row.text);
    if (key) keyToText.set(key, row.text);
  }
  const keys = [...keyToText.keys()];
  if (!keys.length) return empty;
  const inList = keys.map(() => '?').join(',');

  // Accepted, publisher-verified, non-mock discovery results linked to these exact interests.
  const discovery = await db
    .prepare(
      `SELECT d.id, d.title, d.description, d.source, d.url, d.original_url,
              d.publisher_published_at, d.published_at, d.verification_status, dii.interest_key
       FROM discovery_items d
       JOIN discovery_item_interests dii ON dii.item_id = d.id
       WHERE dii.interest_key IN (${inList})
         AND d.is_mock = 0
         AND d.original_url IS NOT NULL
         AND d.verification_status LIKE 'publisher_metadata%'`
    )
    .bind(...keys)
    .all<DiscoveryRow>();

  // Direct-source items are linked to sources, not to individual interests; every post
  // must pass the relevance check for the subscriber's own interest text below.
  const direct = await db
    .prepare(
      `SELECT di.id, di.title, di.content, di.url, di.published_at, ds.name AS source, dsi.interest_key
       FROM direct_items di
       JOIN direct_sources ds ON ds.id = di.source_id
       JOIN direct_source_interests dsi ON dsi.source_id = di.source_id
       WHERE dsi.interest_key IN (${inList})`
    )
    .bind(...keys)
    .all<DirectRow>();

  const candidates: Candidate[] = [];
  for (const row of discovery.results) {
    const url = row.original_url || row.url;
    if (blockedHost(url)) continue;
    candidates.push({
      kind: 'discovery',
      itemId: row.id,
      title: row.title,
      description: row.description,
      source: row.source || null,
      publishedAt: row.publisher_published_at || row.published_at || null,
      url,
      interestKey: row.interest_key,
    });
  }
  for (const row of direct.results) {
    if (blockedHost(row.url)) continue;
    const interestText = keyToText.get(row.interest_key);
    if (!interestText) continue;
    const decision = evaluate(interestText, {
      title: row.title,
      url: row.url,
      source: row.source,
      description: row.content || '',
      publishedAt: row.published_at || null,
      provider: 'direct',
    });
    if (!decision.accepted) continue;
    candidates.push({
      kind: 'direct',
      itemId: row.id,
      title: row.title,
      description: row.content,
      source: row.source || null,
      publishedAt: row.published_at || null,
      url: row.url,
      interestKey: row.interest_key,
    });
  }
  if (!candidates.length) return empty;

  const existing = await db.prepare('SELECT url FROM notifications WHERE subscriber_id=?').bind(subscriberId).all<{ url: string }>();
  const seen = new Set(existing.results.map((row) => canonicalUrl(row.url)));
  candidates.sort((a, b) => (b.publishedAt ? Date.parse(b.publishedAt) || 0 : 0) - (a.publishedAt ? Date.parse(a.publishedAt) || 0 : 0));

  const preparedAt = nowISO();
  const items: NotificationItem[] = [];
  for (const cand of candidates) {
    if (items.length >= limit) break;
    const urlKey = canonicalUrl(cand.url);
    if (seen.has(urlKey)) continue;
    seen.add(urlKey);
    const item: NotificationItem = {
      id: uuid(),
      kind: cand.kind,
      itemId: cand.itemId,
      title: cand.title,
      source: cand.source || null,
      publishedAt: cand.publishedAt,
      excerpt: excerptOf(cand.description),
      url: cand.url,
      interestKey: cand.interestKey,
    };
    // INSERT OR IGNORE + the unique (subscriber, item) constraint backstop concurrent runs.
    const inserted = await db
      .prepare('INSERT OR IGNORE INTO notifications (id,subscriber_id,item_kind,item_id,interest_key,title,source,url,published_at,excerpt,status,prepared_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)')
      .bind(item.id, subscriberId, item.kind, item.itemId, item.interestKey, item.title, item.source, item.url, item.publishedAt, item.excerpt, 'prepared', preparedAt)
      .run();
    if (inserted.meta.changes) items.push(item);
  }
  return { subscriberId, items, text: renderNotificationText(items, opts.lang ?? 'ar') };
}

// Only an explicit successful delivery may mark a notification sent; sent rows are final.
// Failed rows stay retryable; status is never inferred from preparation.
export async function markNotificationStatus(db: Database, id: string, status: 'sent' | 'failed', error?: string): Promise<boolean> {
  if (status !== 'sent' && status !== 'failed') throw new Error('status must be sent or failed');
  const result =
    status === 'sent'
      ? await db.prepare("UPDATE notifications SET status='sent', sent_at=?, error=NULL WHERE id=? AND status IN ('prepared','failed','sending')").bind(nowISO(), id).run()
      : await db.prepare("UPDATE notifications SET status='failed', error=? WHERE id=? AND status IN ('prepared','failed','sending')").bind(error ? error.slice(0, 500) : null, id).run();
  return result.meta.changes > 0;
}

// Sends the subscriber's pending rows through an injected transport (prepared, and
// failed rows when retrying). Marks sent only when the transport reports success.
export async function deliverPending(
  db: Database,
  subscriberId: string,
  transport: DeliveryTransport,
  opts: { includeFailed?: boolean; limit?: number; persist?: boolean } = {}
): Promise<DeliveryResult> {
  const includeFailed = opts.includeFailed !== false;
  const limit = Math.max(1, Math.min(opts.limit ?? MAX_ITEMS, MAX_ITEMS));
  const staleCutoff = new Date(Date.now() - 10 * 60 * 1000).toISOString();
  const eligible = includeFailed ? "status IN ('prepared','failed')" : "status='prepared'";
  const rows = await db
    .prepare(
      `SELECT id, item_kind, title, source, url, published_at, excerpt FROM notifications
       WHERE subscriber_id=? AND (${eligible} OR (status='sending' AND claimed_at IS NOT NULL AND claimed_at < ?))
       ORDER BY prepared_at, id LIMIT ?`
    )
    .bind(subscriberId, staleCutoff, limit)
    .all<{ id: string; item_kind: string; title: string; source: string | null; url: string; published_at: string | null; excerpt: string | null }>();
  if (!rows.results.length) return { subscriberId, sent: 0, failed: 0, messages: [] };

  // Preview-only mode (endpoint simulation): render and hand to the transport without
  // claiming or changing any status, so it can never mark rows as genuinely delivered.
  if (opts.persist === false) {
    const text = renderNotificationText(
      rows.results.map((row) => ({
        id: row.id,
        kind: row.item_kind === 'direct' ? 'direct' : 'discovery',
        itemId: '',
        title: row.title,
        source: row.source,
        publishedAt: row.published_at,
        excerpt: row.excerpt,
        url: row.url,
        interestKey: '',
      }))
    );
    await transport.send(text);
    return { subscriberId, sent: 0, failed: 0, messages: [text] };
  }

  // Claim each row atomically so overlapping scheduled runs cannot double-send.
  // Stale claims older than the lease are reclaimable.
  const now = nowISO();
  const claimed: typeof rows.results = [];
  for (const row of rows.results) {
    const res = await db
      .prepare(
        `UPDATE notifications SET status='sending', claimed_at=? WHERE id=? AND (${eligible} OR (status='sending' AND claimed_at IS NOT NULL AND claimed_at < ?))`
      )
      .bind(now, row.id, staleCutoff)
      .run();
    if (res.meta.changes) claimed.push(row);
  }
  if (!claimed.length) return { subscriberId, sent: 0, failed: 0, messages: [] };

  const items: NotificationItem[] = claimed.map((row) => ({
    id: row.id,
    kind: row.item_kind === 'direct' ? 'direct' : 'discovery',
    itemId: '',
    title: row.title,
    source: row.source,
    publishedAt: row.published_at,
    excerpt: row.excerpt,
    url: row.url,
    interestKey: '',
  }));
  const text = renderNotificationText(items);
  const result = await transport.send(text);
  if (result.ok) {
    for (const row of claimed) await markNotificationStatus(db, row.id, 'sent');
    return { subscriberId, sent: claimed.length, failed: 0, messages: [text] };
  }
  const error = result.error || 'delivery failed';
  for (const row of claimed) await markNotificationStatus(db, row.id, 'failed', error);
  return { subscriberId, sent: 0, failed: claimed.length, messages: [text] };
}

// Workflow: prepare personalized previews for one or all subscribers, optionally
// delivering through a transport. Without a transport this is a dry run: rows are
// left in the prepared state and no messaging of any kind is performed.
export async function runPreparation(
  db: Database,
  opts: { subscriberId?: string; transport?: DeliveryTransport; transportFor?: (subscriberId: string) => DeliveryTransport | undefined; lang?: 'ar' | 'en'; limit?: number; persist?: boolean } = {}
): Promise<PreparationSummary> {
  const dryRun = !opts.transport && !opts.transportFor;
  const subscribers = opts.subscriberId
    ? [{ subscriber_id: opts.subscriberId }]
    : (await db.prepare('SELECT DISTINCT subscriber_id AS subscriber_id FROM subscriber_interests').bind().all<{ subscriber_id: string }>()).results;
  const summary: PreparationSummary = { dryRun, subscribers: subscribers.length, prepared: 0, sent: 0, failed: 0, details: [], messages: [] };
  for (const sub of subscribers) {
    const prepared = await prepareNotifications(db, sub.subscriber_id, { lang: opts.lang, limit: opts.limit });
    summary.prepared += prepared.items.length;
    const transport = opts.transportFor ? opts.transportFor(sub.subscriber_id) : opts.transport;
    if (!transport) {
      // Dry run (or no delivery channel for this subscriber): rows stay prepared.
      summary.details.push({ subscriberId: sub.subscriber_id, prepared: prepared.items.length, delivered: prepared.items.length ? 'prepared' : 'no_items' });
      continue;
    }
    // With a transport, always deliver pending rows so failed batches can be retried
    // even when no new items were prepared in this run.
    const delivery = await deliverPending(db, sub.subscriber_id, transport, { includeFailed: true, limit: opts.limit, persist: opts.persist });
    summary.sent += delivery.sent;
    summary.failed += delivery.failed;
    summary.messages.push(...delivery.messages);
    summary.details.push({ subscriberId: sub.subscriber_id, prepared: prepared.items.length, delivered: opts.persist === false ? 'prepared' : delivery.sent ? 'sent' : delivery.failed ? 'failed' : 'no_items' });
  }
  return summary;
}

// ---------------------------------------------------------------------------
// Delivery simulation and notification selection (no Telegram API is contacted).
// ---------------------------------------------------------------------------

export interface NotificationRecord {
  id: string;
  itemKind: string;
  title: string;
  source: string | null;
  url: string;
  publishedAt: string | null;
  excerpt: string | null;
  status: string;
  preparedAt: string;
  sentAt: string | null;
  error: string | null;
}

export async function listNotifications(
  db: Database,
  subscriberId: string,
  statuses: Array<'prepared' | 'sent' | 'failed'> = ['prepared', 'sent', 'failed']
): Promise<NotificationRecord[]> {
  const allowed = statuses.filter((s) => s === 'prepared' || s === 'sent' || s === 'failed');
  if (!allowed.length) return [];
  const inList = allowed.map(() => '?').join(',');
  const rows = await db
    .prepare(
      `SELECT id, item_kind, title, source, url, published_at, excerpt, status, prepared_at, sent_at, error
       FROM notifications WHERE subscriber_id=? AND status IN (${inList})
       ORDER BY COALESCE(sent_at, prepared_at) DESC, id`
    )
    .bind(subscriberId, ...allowed)
    .all<{ id: string; item_kind: string; title: string; source: string | null; url: string; published_at: string | null; excerpt: string | null; status: string; prepared_at: string; sent_at: string | null; error: string | null }>();
  return rows.results.map((row) => ({
    id: row.id,
    itemKind: row.item_kind,
    title: row.title,
    source: row.source,
    url: row.url,
    publishedAt: row.published_at,
    excerpt: row.excerpt,
    status: row.status,
    preparedAt: row.prepared_at,
    sentAt: row.sent_at,
    error: row.error,
  }));
}

// Details are rendered strictly from what was stored at preparation time. Missing
// fields are omitted; nothing is fetched or invented.
function detailsText(row: { title: string; source: string | null; url: string; published_at: string | null; excerpt: string | null }): string {
  const lines = [row.title];
  if (row.source) lines.push(row.source);
  const day = dayOf(row.published_at);
  if (day) lines.push(day);
  if (row.excerpt) lines.push(row.excerpt);
  if (row.url) lines.push(row.url);
  return lines.join('\n');
}

export interface NotificationDetails {
  id: string;
  status: string;
  text: string;
}

export async function notificationDetails(db: Database, subscriberId: string, notificationId: string): Promise<NotificationDetails | null> {
  const row = await db
    .prepare('SELECT id, title, source, url, published_at, excerpt, status FROM notifications WHERE id=? AND subscriber_id=?')
    .bind(notificationId, subscriberId)
    .first<{ id: string; title: string; source: string | null; url: string; published_at: string | null; excerpt: string | null; status: string }>();
  if (!row) return null;
  return { id: row.id, status: row.status, text: detailsText(row) };
}

// In-memory Telegram-shaped transport for automated tests and manual simulation.
// It never performs network I/O; failures are injected explicitly.
export function createMockTelegramTransport(opts: { failError?: string } = {}): DeliveryTransport & { messages: string[] } {
  const messages: string[] = [];
  return {
    messages,
    async send(text: string) {
      if (opts.failError) return { ok: false, error: opts.failError };
      messages.push(text);
      return { ok: true };
    },
  };
}

// Real Telegram transport on top of the existing Bot API abstraction (tgSendLong).
// It is only reachable when the notify route passes it, which requires the explicit
// server-side TELEGRAM_DELIVERY_ENABLED flag. Sends are sequential and capped to one
// message per subscriber per run to stay within Bot API limits.
export function createTelegramTransport(env: Env, chatId: string): DeliveryTransport {
  return { send: async (text) => ({ ok: await tgSendLong(env, chatId, text) }) };
}

