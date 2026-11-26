import { isPrivateChatId, nowISO, tgSendLong, uuid, type Env } from './_lib';
import { evaluateDirect, normalize, type Database } from './_discovery';
import { institutionForVerifiedPost } from './_source_catalog';

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
  interestText?: string;
  observedAt?: string | null;
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
    const url = new URL(raw);
    const h = url.hostname.toLowerCase();
    return !['http:', 'https:'].includes(url.protocol) || !!url.username || !!url.password || h === 'news.google.com' || h.endsWith('.test');
  } catch {
    return true;
  }
}

export function renderNotificationText(items: NotificationItem[], lang: 'ar' | 'en' = 'ar'): string {
  if (!items.length) return '';
  const header = lang === 'ar' ? 'تحديثات حسب اهتماماتك:' : 'Updates matching your interests:';
  const parts = items.map((item) => {
    const meta = [item.source, dayOf(item.publishedAt)].filter((x): x is string => !!x).join(' · ');
    return [...(item.interestText ? [`الاهتمام: ${item.interestText}`] : []), `■ ${item.title}`, ...(meta ? [meta] : []), ...(item.excerpt ? [item.excerpt] : []), item.url, `/more ${item.id}`].join('\n');
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
  discovered_at: string;
}

interface DirectRow {
  id: string;
  title: string;
  content: string | null;
  url: string;
  published_at: string | null;
  source: string;
  interest_key: string;
  verification_status: string;
  source_kind: string;
  source_url: string;
  first_seen: string;
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
  observedAt: string;
}

export interface BetaDeliveryPolicy { invited: string; recipients: string; freshnessHours?: number; expectedChat?: string }
function idSet(value:string):Set<string>{return new Set(value.split(/[\s,]+/).filter(isPrivateChatId));}
export function betaFresh(published:string|null, observed:string|null, baseline:string|null, interestUpdated:string|null, hours=72):boolean {
  // Date-only strings and missing offsets are ambiguous: fail closed for delivery.
  const precise=(s:string|null)=>{
    if(!s)return false;
    const match=/^(\d{4})-(\d{2})-(\d{2})T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/.exec(s);
    if(!match || !Number.isFinite(Date.parse(s)))return false;
    const [year,month,day]=match.slice(1).map(Number),calendar=new Date(Date.UTC(year,month-1,day));
    return calendar.getUTCFullYear()===year && calendar.getUTCMonth()===month-1 && calendar.getUTCDate()===day;
  };
  if(!precise(published)||!precise(observed)||!precise(baseline)||!precise(interestUpdated))return false;
  const now=Date.now(), pub=Date.parse(published!), seen=Date.parse(observed!);
  const windowHours=Number.isFinite(hours) && hours>=1 && hours<=168?hours:72;
  const start=Math.max(Date.parse(baseline!),Date.parse(interestUpdated!));
  return pub>=now-windowHours*3600000 && pub<=now+300000 && pub>start && seen<=now+300000 && seen>start;
}
async function betaIdentity(db:Database,id:string){return db.prepare('SELECT chat_id,created_beta,notifications_enabled_at FROM beta_identities WHERE subscriber_id=?').bind(id).first<{chat_id:string;created_beta:number;notifications_enabled_at:string|null}>();}
function isNewBeta(id:string,identity:{created_beta:number}|null):boolean{return identity?.created_beta===1 || /^beta_[a-f0-9]{64}$/.test(id);}
export async function betaDeliveryAllowed(db:Database,id:string,policy:BetaDeliveryPolicy):Promise<boolean>{
  const b=await betaIdentity(db,id);if(!b || b.created_beta!==1 || !b.notifications_enabled_at || !isPrivateChatId(b.chat_id))return false;
  if(!idSet(policy.invited).has(b.chat_id)||!idSet(policy.recipients).has(b.chat_id)||(policy.expectedChat && policy.expectedChat!==b.chat_id))return false;
  const owner=await db.prepare('SELECT id FROM subscribers WHERE telegram_chat_id=? LIMIT 2').bind(b.chat_id).all<{id:string}>();
  return owner.results.length===1 && owner.results[0].id===id && await subscriberEligible(db,id);
}

// Explicit delivery-eligibility policy for discovered items. A positive publisher-title
// match is required evidence; merely having fetched publisher metadata is not enough.
// Any title mismatch or unacceptable publication-date conflict is fatal.
export function isPublisherVerified(verificationStatus: string | null | undefined): boolean {
  const evidence = (verificationStatus || '').split(';').map((part) => part.trim());
  return evidence[0] === 'publisher_metadata' && evidence.includes('title_match')
    && !evidence.includes('title_mismatch') && !evidence.includes('date_mismatch');
}

// Central subscription-eligibility policy for notification delivery. Trial and active
// subscribers are eligible only while their expiry has not passed; every other status
// (cancelled, expired, paused/pending, or unknown) is ineligible.
export async function subscriberEligible(db: Database, subscriberId: string): Promise<boolean> {
  const row = await db
    .prepare('SELECT status, trial_ends_at, expires_at FROM subscribers WHERE id=?')
    .bind(subscriberId)
    .first<{ status: string; trial_ends_at: string | null; expires_at: string | null }>();
  if (!row) return false;
  const now = nowISO();
  if (row.status === 'trial') return !row.trial_ends_at || row.trial_ends_at > now;
  if (row.status === 'active') return !row.expires_at || row.expires_at > now;
  return false;
}

export async function prepareNotifications(
  db: Database,
  subscriberId: string,
  opts: { limit?: number; lang?: 'ar' | 'en'; beta?: BetaDeliveryPolicy } = {}
): Promise<PreparedNotification> {
  const limit = Math.max(1, Math.min(opts.limit ?? MAX_ITEMS, MAX_ITEMS));
  const empty: PreparedNotification = { subscriberId, items: [], text: '' };

  // Eligibility gate at preparation time: ineligible subscribers are never prepared.
  if (!(await subscriberEligible(db, subscriberId))) return empty;
  const identity=await betaIdentity(db,subscriberId);
  const isBeta=isNewBeta(subscriberId,identity);
  if(isBeta && (!opts.beta || !await betaDeliveryAllowed(db,subscriberId,opts.beta)))return empty;

  const interests = await db.prepare('SELECT text,updated_at FROM subscriber_interests WHERE subscriber_id=?').bind(subscriberId).all<{ text: string; updated_at:string }>();
  const keyToText = new Map<string, string>();
  const keyToUpdated = new Map<string,string>();
  for (const row of interests.results) {
    const key = normalize(row.text);
    if (key) {keyToText.set(key, row.text);keyToUpdated.set(key,row.updated_at);}
  }
  const keys = [...keyToText.keys()];
  if (!keys.length) return empty;
  const inList = keys.map(() => '?').join(',');

  // Accepted, publisher-verified, non-mock discovery results linked to these exact interests.
  const discovery = await db
    .prepare(
      `SELECT d.id, d.title, d.description, d.source, d.url, d.original_url,
              d.publisher_published_at, d.published_at, d.verification_status, d.discovered_at, dii.interest_key
       FROM discovery_items d
       JOIN discovery_item_interests dii ON dii.item_id = d.id
       WHERE dii.interest_key IN (${inList})
         AND d.is_mock = 0
         AND d.original_url IS NOT NULL`
    )
    .bind(...keys)
    .all<DiscoveryRow>();

  // Direct-source items are linked to sources, not to individual interests; every post
  // must pass the relevance check for the subscriber's own interest text below.
  const direct = await db
    .prepare(
      `SELECT di.id, di.title, di.content, di.url, di.published_at, di.first_seen, ds.name AS source, ds.url AS source_url, dsi.interest_key, di.verification_status, ds.kind AS source_kind
       FROM direct_items di
       JOIN direct_sources ds ON ds.id = di.source_id
       JOIN direct_source_interests dsi ON dsi.source_id = di.source_id
       WHERE dsi.interest_key IN (${inList}) AND ((ds.kind='website' AND di.verification_status='publisher_title_match') OR (ds.kind='telegram' AND di.verification_status='telegram_post_verified'))`
    )
    .bind(...keys)
    .all<DirectRow>();

  const candidates: Candidate[] = [];
  for (const row of discovery.results) {
    if (!isPublisherVerified(row.verification_status)) continue;
    if(isBeta && !row.source?.trim())continue;
    if(isBeta && !betaFresh(row.publisher_published_at,row.discovered_at,identity?.notifications_enabled_at || null,keyToUpdated.get(row.interest_key) || null,opts.beta?.freshnessHours))continue;
    const url = row.original_url || row.url;
    if (blockedHost(url)) continue;
    const interestText = keyToText.get(row.interest_key);
    if (!interestText || !evaluateDirect(interestText, {title:row.title,url,source:row.source || '',description:row.description || '',publishedAt:row.publisher_published_at || row.published_at,provider:'discovery'}).accepted) continue;
    candidates.push({
      kind: 'discovery',
      itemId: row.id,
      title: row.title,
      // Search snippets are not necessarily extracted from the publisher.
      description: isBeta ? null : row.description,
      source: row.source || null,
      publishedAt: row.publisher_published_at || row.published_at || null,
      url,
      interestKey: row.interest_key,
      observedAt: row.discovered_at,
    });
  }
  for (const row of direct.results) {
    if (blockedHost(row.url)) continue;
    if(isBeta && !row.source?.trim())continue;
    if(isBeta && !betaFresh(row.published_at,row.first_seen,identity?.notifications_enabled_at || null,keyToUpdated.get(row.interest_key) || null,opts.beta?.freshnessHours))continue;
    const interestText = keyToText.get(row.interest_key);
    if (!interestText) continue;
    const decision = evaluateDirect(interestText, {
      title: row.title,
      url: row.url,
      source: row.source,
      description: row.content || '',
      publishedAt: row.published_at || null,
      provider: 'direct',
    },Date.now(),institutionForVerifiedPost(row.source_url,row.source_kind,row.source,row.url));
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
      observedAt: row.first_seen,
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
      interestText: keyToText.get(cand.interestKey),
      observedAt: cand.observedAt,
    };
    // D1 batch is atomic: a crash cannot leave a canonical-URL reservation
    // without its notification. The conditional insert permits only its owner.
    if(isBeta){
      type Statement=ReturnType<ReturnType<Database['prepare']>['bind']>;
      const batchDb=db as Database & {batch(statements:Statement[]):Promise<Array<{meta:{changes:number}}>>};
      const results=await batchDb.batch([
        db.prepare('INSERT OR IGNORE INTO beta_notification_keys(subscriber_id,url_key,notification_id) VALUES(?,?,?)').bind(subscriberId,urlKey,item.id),
        db.prepare('INSERT OR IGNORE INTO notifications (id,subscriber_id,item_kind,item_id,interest_key,title,source,url,published_at,excerpt,status,prepared_at,observed_at) SELECT ?,?,?,?,?,?,?,?,?,?,?,?,? WHERE EXISTS (SELECT 1 FROM beta_notification_keys WHERE subscriber_id=? AND url_key=? AND notification_id=?)')
          .bind(item.id,subscriberId,item.kind,item.itemId,item.interestKey,item.title,item.source,item.url,item.publishedAt,item.excerpt,'prepared',preparedAt,item.observedAt || null,subscriberId,urlKey,item.id),
        db.prepare('DELETE FROM beta_notification_keys WHERE subscriber_id=? AND url_key=? AND notification_id=? AND NOT EXISTS (SELECT 1 FROM notifications WHERE id=?)').bind(subscriberId,urlKey,item.id,item.id),
      ]);
      if(results[1].meta.changes)items.push(item);
    }else{
      const inserted=await db.prepare('INSERT OR IGNORE INTO notifications (id,subscriber_id,item_kind,item_id,interest_key,title,source,url,published_at,excerpt,status,prepared_at,observed_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)')
        .bind(item.id,subscriberId,item.kind,item.itemId,item.interestKey,item.title,item.source,item.url,item.publishedAt,item.excerpt,'prepared',preparedAt,item.observedAt || null).run();
      if(inserted.meta.changes)items.push(item);
    }
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

interface PendingRow {
  id: string; item_kind: string; item_id: string; interest_key: string;
  title: string; source: string | null; url: string; published_at: string | null; excerpt: string | null; observed_at:string|null;
}

// A queued snapshot is not proof that its underlying item remains safe to send.
// Recheck ownership, provenance and the current direct-source relevance policy.
async function pendingItemValid(db: Database, subscriberId: string, row: PendingRow, beta?:BetaDeliveryPolicy): Promise<boolean> {
  if (blockedHost(row.url)) return false;
  const interests = await db.prepare('SELECT text,updated_at FROM subscriber_interests WHERE subscriber_id=?').bind(subscriberId).all<{ text: string;updated_at:string }>();
  const entry=interests.results.find((item) => normalize(item.text) === row.interest_key);
  const interest = entry?.text;
  if (!interest) return false;
  const identity=beta?await betaIdentity(db,subscriberId):null;
  if(beta && (!identity || !await betaDeliveryAllowed(db,subscriberId,beta) || !betaFresh(row.published_at,row.observed_at,identity.notifications_enabled_at,entry?.updated_at || null,beta.freshnessHours)))return false;

  if (row.item_kind === 'discovery') {
    const item = await db.prepare(`SELECT d.title, d.description, d.source, d.published_at, d.publisher_published_at, d.discovered_at, d.original_url, d.verification_status, d.is_mock
      FROM discovery_items d JOIN discovery_item_interests dii ON dii.item_id=d.id
      WHERE d.id=? AND dii.interest_key=?`).bind(row.item_id, row.interest_key)
      .first<{ title: string; description:string|null; source:string|null; published_at:string|null; publisher_published_at:string|null; discovered_at:string; original_url: string | null; verification_status: string | null; is_mock: number }>();
    return !!item && item.is_mock === 0 && !!item.original_url && !blockedHost(item.original_url)
      && isPublisherVerified(item.verification_status) && item.title === row.title
      && (!beta || (item.publisher_published_at===row.published_at && item.discovered_at===row.observed_at && (item.source || null)===row.source && row.excerpt===null))
      && canonicalUrl(item.original_url) === canonicalUrl(row.url)
      && evaluateDirect(interest,{title:item.title,url:item.original_url,source:item.source || '',description:item.description || '',publishedAt:item.publisher_published_at || item.published_at,provider:'discovery'}).accepted;
  }

  if (row.item_kind === 'direct') {
    const item = await db.prepare(`SELECT di.title, di.content, di.url, di.published_at, di.first_seen, ds.name AS source, ds.url AS source_url, ds.kind AS source_kind, di.verification_status
      FROM direct_items di JOIN direct_sources ds ON ds.id=di.source_id
      JOIN direct_source_interests dsi ON dsi.source_id=di.source_id
      WHERE di.id=? AND dsi.interest_key=?`).bind(row.item_id, row.interest_key)
      .first<{ title: string; content: string | null; url: string; published_at: string | null; first_seen:string; source: string; source_url:string; source_kind:string; verification_status:string }>();
    if (!item || blockedHost(item.url) || item.title !== row.title || canonicalUrl(item.url) !== canonicalUrl(row.url)) return false;
    if (!((item.source_kind==='website' && item.verification_status==='publisher_title_match') || (item.source_kind==='telegram' && item.verification_status==='telegram_post_verified'))) return false;
    if(beta && (item.published_at!==row.published_at || item.first_seen!==row.observed_at || item.source!==row.source || excerptOf(item.content)!==row.excerpt))return false;
    return evaluateDirect(interest, { title: item.title, url: item.url, source: item.source,
      description: item.content || '', publishedAt: item.published_at, provider: 'direct' },Date.now(),institutionForVerifiedPost(item.source_url,item.source_kind,item.source,item.url)).accepted;
  }
  return false;
}

// Read-only status for the beta screen; a queued row counts only if it still
// satisfies the same ownership, provenance and freshness checks as delivery.
export async function countBetaReadyNotifications(db:Database,subscriberId:string,policy:BetaDeliveryPolicy):Promise<number>{
  if(!await betaDeliveryAllowed(db,subscriberId,policy))return 0;
  const rows=await db.prepare("SELECT id,item_kind,item_id,interest_key,title,source,url,published_at,excerpt,observed_at FROM notifications WHERE subscriber_id=? AND status IN ('prepared','failed') ORDER BY prepared_at DESC LIMIT 30").bind(subscriberId).all<PendingRow>();
  let count=0;for(const row of rows.results)if(await pendingItemValid(db,subscriberId,row,policy))count++;
  return count;
}

// Sends the subscriber's pending rows through an injected transport (prepared, and
// failed rows when retrying). Marks sent only when the transport reports success.
export async function deliverPending(
  db: Database,
  subscriberId: string,
  transport: DeliveryTransport,
  opts: { includeFailed?: boolean; limit?: number; persist?: boolean; beta?:BetaDeliveryPolicy; safeNoRetry?:boolean } = {}
): Promise<DeliveryResult> {
  const includeFailed = opts.includeFailed !== false;
  const limit = Math.max(1, Math.min(opts.limit ?? MAX_ITEMS, MAX_ITEMS));
  // Eligibility gate before claiming: an ineligible subscriber is never claimed or sent.
  if (!(await subscriberEligible(db, subscriberId))) return { subscriberId, sent: 0, failed: 0, messages: [] };
  const identity=await betaIdentity(db,subscriberId);
  if(isNewBeta(subscriberId,identity) && (!opts.beta || !await betaDeliveryAllowed(db,subscriberId,opts.beta)))return {subscriberId,sent:0,failed:0,messages:[]};
  const staleCutoff = new Date(Date.now() - 10 * 60 * 1000).toISOString();
  const eligible = includeFailed && !opts.safeNoRetry ? "status IN ('prepared','failed')" : "status='prepared'";
  const stale = opts.safeNoRetry ? '(0 AND claimed_at < ?)' : "(status='sending' AND claimed_at IS NOT NULL AND claimed_at < ?)";
  const rows = await db
    .prepare(
      `SELECT id, item_kind, item_id, interest_key, title, source, url, published_at, excerpt, observed_at FROM notifications
       WHERE subscriber_id=? AND (${eligible} OR ${stale})
       ORDER BY prepared_at, id LIMIT ?`
    )
    .bind(subscriberId, staleCutoff, limit)
    .all<PendingRow>();
  if (!rows.results.length) return { subscriberId, sent: 0, failed: 0, messages: [] };

  // Preview-only mode (endpoint simulation): render and hand to the transport without
  // claiming or changing any status, so it can never mark rows as genuinely delivered.
  if (opts.persist === false) {
    const validRows: PendingRow[] = [];
    for (const row of rows.results) if (await pendingItemValid(db, subscriberId, row,opts.beta)) validRows.push(row);
    if (!validRows.length) return { subscriberId, sent: 0, failed: 0, messages: [] };
    const text = renderNotificationText(
      validRows.map((row) => ({
        id: row.id,
        kind: row.item_kind === 'direct' ? 'direct' : 'discovery',
        itemId: '',
        title: row.title,
        source: row.source,
        publishedAt: row.published_at,
        excerpt: row.excerpt,
        url: row.url,
        interestKey: row.interest_key,
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
        `UPDATE notifications SET status='sending', claimed_at=? WHERE id=? AND (${eligible} OR ${stale})`
      )
      .bind(now, row.id, staleCutoff)
      .run();
    if (res.meta.changes) claimed.push(row);
  }
  if (!claimed.length) return { subscriberId, sent: 0, failed: 0, messages: [] };

  const validClaimed: PendingRow[] = [];
  for (const row of claimed) {
    if (await pendingItemValid(db, subscriberId, row,opts.beta)) validClaimed.push(row);
    else await db.prepare("UPDATE notifications SET status='rejected', claimed_at=NULL, error=? WHERE id=? AND status='sending' AND claimed_at=?")
      .bind('content failed delivery revalidation', row.id, now).run();
  }
  if (!validClaimed.length) return { subscriberId, sent: 0, failed: 0, messages: [] };

  const currentInterests=await db.prepare('SELECT text FROM subscriber_interests WHERE subscriber_id=?').bind(subscriberId).all<{text:string}>();
  const items: NotificationItem[] = validClaimed.map((row) => ({
    id: row.id,
    kind: row.item_kind === 'direct' ? 'direct' : 'discovery',
    itemId: '',
    title: row.title,
    source: row.source,
    publishedAt: row.published_at,
    excerpt: row.excerpt,
    url: row.url,
    interestKey: row.interest_key,
    interestText: currentInterests.results.find(x=>normalize(x.text)===row.interest_key)?.text,
  }));
  const text = renderNotificationText(items);
  // Re-check eligibility immediately before sending: a subscriber who became
  // ineligible after claiming must not receive the message. Release this run's claim
  // (scoped to our claim token so a concurrent run's fresh claim is never overwritten).
  let canSend=await subscriberEligible(db, subscriberId) && (!opts.beta || await betaDeliveryAllowed(db,subscriberId,opts.beta));
  if(canSend){for(const row of validClaimed){const state=await db.prepare("SELECT id FROM notifications WHERE id=? AND subscriber_id=? AND status='sending' AND claimed_at=?").bind(row.id,subscriberId,now).first();if(!state || !await pendingItemValid(db,subscriberId,row,opts.beta)){canSend=false;break;}}}
  if (!canSend) {
    for (const row of validClaimed) {
      await db.prepare("UPDATE notifications SET status='prepared', claimed_at=NULL, error=NULL WHERE id=? AND status='sending' AND claimed_at=?").bind(row.id, now).run();
    }
    return { subscriberId, sent: 0, failed: 0, messages: [] };
  }
  const result = await transport.send(text);
  if (result.ok) {
    for (const row of validClaimed) await markNotificationStatus(db, row.id, 'sent');
    return { subscriberId, sent: validClaimed.length, failed: 0, messages: [text] };
  }
  const error = result.error || 'delivery failed';
  for (const row of validClaimed) await markNotificationStatus(db, row.id, 'failed', error);
  return { subscriberId, sent: 0, failed: validClaimed.length, messages: [text] };
}

// Workflow: prepare personalized previews for one or all subscribers, optionally
// delivering through a transport. Without a transport this is a dry run: rows are
// left in the prepared state and no messaging of any kind is performed.
export async function runPreparation(
  db: Database,
  opts: { subscriberId?: string; transport?: DeliveryTransport; transportFor?: (subscriberId: string) => DeliveryTransport | undefined; lang?: 'ar' | 'en'; limit?: number; persist?: boolean; beta?:BetaDeliveryPolicy } = {}
): Promise<PreparationSummary> {
  const dryRun = !opts.transport && !opts.transportFor;
  const subscribers = opts.subscriberId
    ? [{ subscriber_id: opts.subscriberId }]
    : (await db.prepare('SELECT DISTINCT subscriber_id AS subscriber_id FROM subscriber_interests').bind().all<{ subscriber_id: string }>()).results;
  const summary: PreparationSummary = { dryRun, subscribers: subscribers.length, prepared: 0, sent: 0, failed: 0, details: [], messages: [] };
  for (const sub of subscribers) {
    const prepared = await prepareNotifications(db, sub.subscriber_id, { lang: opts.lang, limit: opts.limit, beta:opts.beta });
    summary.prepared += prepared.items.length;
    const transport = opts.transportFor ? opts.transportFor(sub.subscriber_id) : opts.transport;
    if (!transport) {
      // Dry run (or no delivery channel for this subscriber): rows stay prepared.
      summary.details.push({ subscriberId: sub.subscriber_id, prepared: prepared.items.length, delivered: prepared.items.length ? 'prepared' : 'no_items' });
      continue;
    }
    // With a transport, always deliver pending rows so failed batches can be retried
    // even when no new items were prepared in this run.
    const delivery = await deliverPending(db, sub.subscriber_id, transport, { includeFailed: true, limit: opts.limit, persist: opts.persist, beta:opts.beta });
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

