export interface Env {
  DB: D1Database;
  ADMIN_PASSWORD: string;
  CRON_SECRET: string;
  BREVO_API_KEY?: string;
  SENDER_EMAIL?: string;
  SITE_URL?: string;
  TELEGRAM_BOT_TOKEN?: string;
  TELEGRAM_WEBHOOK_SECRET?: string;
  TELEGRAM_BOT?: string;
  /** Server-side only: enables real Telegram delivery from the notify workflow. Never set by default. */
  TELEGRAM_DELIVERY_ENABLED?: string;
  BETA_SCHEDULED_DELIVERY_ENABLED?: string;
  DISCOVERY_EXPAND_LINKED_SOURCES?: string;
  /** Server-side only: comma-separated Telegram chat IDs permitted during controlled delivery tests. */
  TELEGRAM_TEST_CHAT_IDS?: string;
  /** Test/demo only: enables the deterministic mock discovery endpoint. Never set in production. */
  ALLOW_MOCK_DISCOVERY?: string;
  BETA_DURATION_DAYS?: string;
  BETA_ALLOWED_TELEGRAM_IDS?: string;
  BETA_FRESHNESS_HOURS?: string;
  /** Daily digest email provider (Resend preferred; Brevo kept as fallback). */
  RESEND_API_KEY?: string;
  EMAIL_FROM?: string;
  /** Test-only: reports success without contacting any provider. */
  EMAIL_MOCK?: string;
  /** Isolated two-user staging pilot only; never enable on production. */
  STAGING_PILOT_MODE?: string;
  STAGING_D1_ID?: string;
  /** RSS-only staging MVP mode: restricted host/paths, no Telegram/Beta requirements. */
  RSS_STAGING_MODE?: string;
}

// Staging fails closed on malformed, duplicate or more than two identities.
// An empty delivery allowlist is expected while real delivery is disabled.
export function stagingAllowlistsValid(env: Env): boolean {
  if (env.STAGING_PILOT_MODE !== '1') return true;
  const parse=(value:string|undefined):string[]|null=>{
    if(!value?.trim())return [];
    const ids=value.split(',').map(x=>x.trim());
    return ids.length<=2 && ids.every(x=>/^[1-9]\d*$/.test(x)) && new Set(ids).size===ids.length ? ids : null;
  };
  const invited=parse(env.BETA_ALLOWED_TELEGRAM_IDS),recipients=parse(env.TELEGRAM_TEST_CHAT_IDS);
  return !!invited && invited.length>0 && !!recipients && recipients.every(id=>invited.includes(id));
}

export type PagesContext<C = Env> = { request: Request; env: C; params: Record<string, string>; waitUntil: (promise: Promise<unknown>) => void };
export type Handler<C = Env> = (ctx: PagesContext<C>) => Promise<Response>;

export function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "content-type": "application/json", "cache-control": "no-store" },
  });
}

export function fail(error: string, status = 400): Response {
  return json({ error }, status);
}

export const nowISO = (): string => new Date().toISOString();
export const uuid = (): string => crypto.randomUUID();

/** Damascus time = UTC+3, no DST. */
export function damascusNow(): Date {
  return new Date(Date.now() + 3 * 3600 * 1000);
}
export function damascusHour(): number {
  return damascusNow().getUTCHours();
}
export function damascusTodayStartISO(): string {
  const d = damascusNow();
  d.setUTCHours(0, 0, 0, 0);
  return new Date(d.getTime() - 3 * 3600 * 1000).toISOString();
}

export function daysFromNow(days: number): string {
  return new Date(Date.now() + days * 24 * 3600 * 1000).toISOString();
}

export async function hmacHex(secret: string, msg: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"]
  );
  const sig = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(msg));
  return [...new Uint8Array(sig)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

function timingEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let r = 0;
  for (let i = 0; i < a.length; i++) r |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return r === 0;
}

export async function makeAdminToken(env: Env): Promise<string> {
  const exp = Date.now() + 7 * 24 * 3600 * 1000;
  const sig = await hmacHex(env.ADMIN_PASSWORD, "admin:" + exp);
  return exp + "." + sig;
}

export async function checkAdmin(request: Request, env: Env): Promise<boolean> {
  if (!env.ADMIN_PASSWORD) return false;
  const h = request.headers.get("authorization") || "";
  const tok = h.startsWith("Bearer ") ? h.slice(7) : "";
  const [exp, sig] = tok.split(".");
  if (!exp || !sig) return false;
  if (!/^\d+$/.test(exp) || Number(exp) < Date.now()) return false;
  const want = await hmacHex(env.ADMIN_PASSWORD, "admin:" + exp);
  return timingEqual(sig, want);
}

export function checkCronSecret(request: Request, env: Env): boolean {
  return !!env.CRON_SECRET && request.headers.get("x-cron-secret") === env.CRON_SECRET;
}

export async function readJson<T>(request: Request): Promise<T> {
  try {
    return (await request.json()) as T;
  } catch {
    return {} as T;
  }
}

export function clientIp(request: Request): string {
  return request.headers.get("cf-connecting-ip") || "unknown";
}

/** نافذة ساعية بسيطة: يُسمح بحد أقصى max محاولة للمفتاح الواحد في الساعة */
export async function rateLimit(env: Env, key: string, max: number): Promise<boolean> {
  if (!env.DB) return true;
  const window = new Date().toISOString().slice(0, 13);
  const k = key + ":" + window;
  const row = await env.DB.prepare("SELECT count FROM rate_limits WHERE key=?").bind(k).first<{ count: number }>();
  if (row && row.count >= max) return false;
  await env.DB.prepare(
    "INSERT INTO rate_limits (key, window, count) VALUES (?,?,1) ON CONFLICT(key) DO UPDATE SET count = count + 1"
  ).bind(k, window).run();
  return true;
}

export function siteUrl(env: Env): string {
  return (env.SITE_URL || "https://dial-syria.pages.dev").replace(/\/$/, "");
}

// Historical Telegram group/channel IDs are negative. Positive IDs alone do not
// establish chat type; inbound updates must still verify Telegram's metadata.
export function isPrivateChatId(value: string): boolean {
  return /^[1-9]\d*$/.test(value);
}

/** إرسال رسائل تيليجرام عبر البوت — مجاني وغير محدود */
export async function tgSend(env: Env, chatId: string, text: string): Promise<boolean> {
  if (!env.TELEGRAM_BOT_TOKEN) return false;
  try {
    const res = await fetch(`https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/sendMessage`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ chat_id: chatId, text, link_preview_options: { is_disabled: true } }),
      signal: AbortSignal.timeout(10000),
    });
    return res.ok;
  } catch {
    return false;
  }
}

/** إرسال نص طويل: تقسيم عند حدود الأقسام فقط (لا قصّ في منتصف كلمة أبداً) */
export async function tgSendLong(env: Env, chatId: string, text: string): Promise<boolean> {
  if (!env.TELEGRAM_BOT_TOKEN) return false;
  const MAX = 3800;
  const parts: string[] = [];
  let cur = "";
  const sectionChunks = text.split(/\n\n(?=■)/);
  for (const c of sectionChunks) {
    if (c.length > MAX) {
      // قسم واحد ضخم: قسّمه قسراً عند حدود الأسطر
      if (cur) { parts.push(cur); cur = ""; }
      let rest = c;
      while (rest.length > MAX) {
        let cut = rest.lastIndexOf("\n", MAX);
        if (cut < MAX * 0.6) cut = MAX;
        parts.push(rest.slice(0, cut));
        rest = rest.slice(cut).replace(/^\n+/, "");
      }
      cur = rest;
      continue;
    }
    if (!cur) cur = c;
    else if ((cur + "\n\n" + c).length <= MAX) cur += "\n\n" + c;
    else { parts.push(cur); cur = c; }
  }
  if (cur) parts.push(cur);
  let allOk = parts.length > 0;
  for (const p of parts) {
    const ok = await tgSend(env, chatId, p);
    if (!ok) allOk = false;
  }
  return allOk;
}

export const VALID_TOPICS = ["politics", "economy", "tech", "sports", "health", "culture"] as const;
export type Topic = (typeof VALID_TOPICS)[number];

export const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
