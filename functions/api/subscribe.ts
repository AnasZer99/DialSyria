import { Env, Handler, fail, json, nowISO, uuid, readJson, daysFromNow, siteUrl, VALID_TOPICS, EMAIL_RE, clientIp, rateLimit, type Topic } from "./_lib";
import { sendEmail } from "./_digest";

export const onRequestPost: Handler = async ({ request, env }) => {
  if (!env.DB) return fail("database not bound", 500);
  if (!env.BREVO_API_KEY || !env.SENDER_EMAIL) return fail("email delivery is not configured", 503);
  if (!(await rateLimit(env, "sub:" + clientIp(request), 10))) return fail("too many requests", 429);
  const body = await readJson<{ email?: string; topics?: string[]; delivery_hour?: number; language?: string; whatsapp?: string }>(request);

  const email = (body.email || "").trim().toLowerCase();
  const topics = Array.isArray(body.topics)
    ? [...new Set(body.topics)].filter((x): x is Topic => (VALID_TOPICS as readonly string[]).includes(x))
    : [];
  const hour = Number(body.delivery_hour);
  const language = body.language === "en" ? "en" : "ar";
  const whatsapp = typeof body.whatsapp === "string" ? body.whatsapp.trim().slice(0, 30) : null;

  if (!EMAIL_RE.test(email)) return fail("invalid email");
  if (topics.length < 1 || topics.length > 3) return fail("choose 1 to 3 topics");
  if (!Number.isInteger(hour) || hour < 0 || hour > 23) return fail("invalid hour");

  const token = uuid();
  const magicExpiry = daysFromNow(30);
  const existing = await env.DB.prepare("SELECT id FROM subscribers WHERE email = ?").bind(email).first<{ id: string }>();

  if (existing) {
    // Existing account preferences may only be changed through an authenticated link.
    return json({ ok: true });
  } else {
    const id = uuid();
    await env.DB.batch([
      env.DB.prepare(
        "INSERT INTO subscribers (id, email, whatsapp, language, delivery_hour, status, trial_ends_at, created_at, magic_token, magic_expires) VALUES (?,?,?,?,?,?,?,?,?,?)"
      ).bind(id, email, whatsapp, language, hour, "trial", daysFromNow(3), nowISO(), token, magicExpiry),
      ...topics.map((x) =>
        env.DB.prepare("INSERT INTO subscriber_topics (subscriber_id, topic) VALUES (?, ?)").bind(id, x)
      ),
    ]);
  }

  const manageUrl = siteUrl(env) + "/manage?token=" + token;
  const providerConfigured = !!(env.BREVO_API_KEY && env.SENDER_EMAIL);

  if (providerConfigured) {
    const subject = language === "ar" ? "مرحباً بك في ديل سيريا — رابط إدارة اشتراكك" : "Welcome to DialSyria — your access link";
    const bodyHtml =
      language === "ar"
        ? `<div dir="rtl" style="font-family:Tahoma,Arial;font-size:15px;line-height:2;color:#1B2635;background:#FBF8F1;padding:24px;"><b>مرحباً بك في ديل سيريا</b><br/>بدأت تجربتك المجانية لمدة 3 أيام، وستصلك نشرة اليومية في الوقت الذي اخترته.<br/><a href="${manageUrl}" style="color:#9C4A3C;font-weight:bold;">إدارة الاشتراك والوقت والمواضيع ↗</a></div>`
        : `<div dir="ltr" style="font-family:Tahoma,Arial;font-size:15px;line-height:2;color:#1B2635;background:#FBF8F1;padding:24px;"><b>Welcome to DialSyria</b><br/>Your free 3-day trial has started, and your daily digest arrives at your chosen time.<br/><a href="${manageUrl}" style="color:#9C4A3C;font-weight:bold;">Manage your subscription ↗</a></div>`;
    if (!(await sendEmail(env, email, subject, bodyHtml))) return fail("could not send access email; request a new login link", 503);
  }

  return json({ ok: true });
};
