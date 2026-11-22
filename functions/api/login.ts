import { Env, Handler, fail, json, readJson, daysFromNow, uuid, siteUrl, EMAIL_RE, clientIp, rateLimit } from "./_lib";
import { sendEmail } from "./_digest";

export const onRequestPost: Handler = async ({ request, env }) => {
  if (!env.DB) return fail("database not bound", 500);
  if (!(await rateLimit(env, "login:" + clientIp(request), 5))) return fail("too many requests", 429);
  const { email: raw } = await readJson<{ email?: string }>(request);
  const email = (raw || "").trim().toLowerCase();
  if (!EMAIL_RE.test(email)) return fail("invalid email");

  const row = await env.DB.prepare("SELECT id, language FROM subscribers WHERE email = ?").bind(email).first<{ id: string; language: string }>();

  // never reveal whether an address is subscribed
  if (!row) return json({ ok: true });

  const token = uuid();
  const magicExpiry = daysFromNow(30);
  await env.DB.prepare("UPDATE subscribers SET magic_token=?, magic_expires=? WHERE id=?").bind(token, magicExpiry, row.id).run();

  const manageUrl = siteUrl(env) + "/manage?token=" + token;
  const providerConfigured = !!(env.BREVO_API_KEY && env.SENDER_EMAIL);

  if (providerConfigured) {
    const lang = row.language === "en" ? "en" : "ar";
    const subject = lang === "ar" ? "رابط دخولك إلى ديل سيريا" : "Your DialSyria access link";
    const bodyHtml =
      lang === "ar"
        ? `<div dir="rtl" style="font-family:Tahoma,Arial;font-size:15px;line-height:2;color:#1B2635;background:#FBF8F1;padding:24px;">اضغط الرابط لإدارة اشتراكك:<br/><a href="${manageUrl}" style="color:#9C4A3C;font-weight:bold;">إدارة الاشتراك ↗</a></div>`
        : `<div dir="ltr" style="font-family:Tahoma,Arial;font-size:15px;line-height:2;color:#1B2635;background:#FBF8F1;padding:24px;">Click the link to manage your subscription:<br/><a href="${manageUrl}" style="color:#9C4A3C;font-weight:bold;">Manage subscription ↗</a></div>`;
    await sendEmail(env, email, subject, bodyHtml);
  }

  return json({ ok: true, manage_url: providerConfigured ? undefined : manageUrl });
};
