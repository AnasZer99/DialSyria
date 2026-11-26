import type { Env } from "./_lib";

/**
 * Minimal email transport for the daily digest.
 *
 * Provider preference: mock (tests only) → Resend → Brevo (legacy integration
 * kept working). No provider is contacted unless its key and sender are set.
 * Errors are reduced to status codes so keys never leak into logs.
 */
export interface EmailMessage {
  to: string;
  subject: string;
  html: string;
}

export type EmailProvider = "mock" | "resend" | "brevo" | "none";

export interface EmailOutcome {
  ok: boolean;
  provider: EmailProvider;
  id?: string;
  status?: number;
  error?: string;
}

const MAX_HTML = 200_000;

export function emailProvider(env: Env): EmailProvider {
  if (env.EMAIL_MOCK === "1") return "mock";
  if (env.RESEND_API_KEY && (env.EMAIL_FROM || env.SENDER_EMAIL)) return "resend";
  if (env.BREVO_API_KEY && env.SENDER_EMAIL) return "brevo";
  return "none";
}

export async function sendEmailMessage(
  env: Env,
  msg: EmailMessage,
  fetcher: typeof fetch = fetch
): Promise<EmailOutcome> {
  const provider = emailProvider(env);
  const html = msg.html.slice(0, MAX_HTML);
  if (provider === "none") return { ok: false, provider, error: "no_provider" };
  if (provider === "mock") return { ok: true, provider, id: "mock-" + Date.now() };

  try {
    if (provider === "resend") {
      const res = await fetcher("https://api.resend.com/emails", {
        method: "POST",
        headers: {
          authorization: `Bearer ${env.RESEND_API_KEY}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({
          from: env.EMAIL_FROM || env.SENDER_EMAIL,
          to: [msg.to],
          subject: msg.subject,
          html,
        }),
        signal: AbortSignal.timeout(12000),
      });
      const data = (await res.json().catch(() => ({}))) as { id?: string };
      return res.ok
        ? { ok: true, provider, status: res.status, id: data.id }
        : { ok: false, provider, status: res.status, error: `HTTP ${res.status}` };
    }

    const res = await fetcher("https://api.brevo.com/v3/smtp/email", {
      method: "POST",
      headers: { "api-key": env.BREVO_API_KEY as string, "content-type": "application/json" },
      body: JSON.stringify({
        sender: { email: env.SENDER_EMAIL, name: "DialSyria" },
        to: [{ email: msg.to }],
        subject: msg.subject,
        htmlContent: html,
      }),
      signal: AbortSignal.timeout(12000),
    });
    return res.ok
      ? { ok: true, provider, status: res.status }
      : { ok: false, provider, status: res.status, error: `HTTP ${res.status}` };
  } catch (e) {
    const name = e instanceof Error ? e.name : "error";
    return { ok: false, provider, error: name === "TimeoutError" || name === "AbortError" ? "timeout" : name };
  }
}
