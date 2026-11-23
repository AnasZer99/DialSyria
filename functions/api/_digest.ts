import { Env, nowISO, uuid, damascusHour, damascusTodayStartISO, siteUrl, tgSendLong, type Topic } from "./_lib";

const TOPIC_NAMES: Record<"ar" | "en", Record<Topic, string>> = {
  ar: {
    politics: "سياسة", economy: "اقتصاد", tech: "تكنولوجيا",
    sports: "رياضة", health: "صحة وعلوم", culture: "ثقافة وفن",
  },
  en: {
    politics: "Politics", economy: "Economy", tech: "Technology",
    sports: "Sports", health: "Health & Science", culture: "Culture & Arts",
  },
};

const S = {
  ar: {
    subject: "نشرة ديل سيريا اليومية",
    first: "سوريا — الداخل والخارج",
    world: "عالمي",
    readMore: "اقرأ الخبر كاملاً",
    manage: "إدارة الاشتراك",
    via: "من",
    tagline: "أخبار سوريا والعالم، في الوقت الذي اخترته",
  },
  en: {
    subject: "DialSyria daily digest",
    first: "Syria — home & abroad",
    world: "World",
    readMore: "Read the full story",
    manage: "Manage subscription",
    via: "via",
    tagline: "Syria and world news, at the time you chose",
  },
};

interface ArticleRow {
  id: string;
  title: string;
  summary: string | null;
  url: string;
  source: string;
  topic: string;
  scope: string;
  published_at: string | null;
}

interface SubRow {
  id: string;
  email: string;
  language: string;
  telegram_chat_id: string | null;
  topics_csv: string | null;
}

function esc(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

export function digestHtml(
  lang: "ar" | "en",
  sections: DigestSection[],
  manageUrl: string
): string {
  const L = S[lang];
  const dir = lang === "ar" ? "rtl" : "ltr";
  const today = new Date().toLocaleDateString(lang === "ar" ? "ar-SY-u-nu-latn" : "en-GB", {
    year: "numeric", month: "long", day: "numeric",
  });

  const rendered = sections
    .map((sec) => {
      const items = sec.items
        .map(
          (a) => `
          <div style="margin:0 0 22px 0;padding:0 0 18px 0;border-bottom:1px solid #D9D0BD;">
            <div style="font-size:17px;line-height:1.7;font-weight:700;margin-bottom:6px;">
              <a href="${esc(a.url)}" style="color:#1B2635;text-decoration:none;">${esc(a.title)}</a>
            </div>
            ${a.summary ? `<div style="font-size:13px;line-height:1.9;color:#5C6672;margin-bottom:8px;">${esc(a.summary)}</div>` : ""}
            <div style="font-size:12px;color:#5C6672;">${esc(L.via)} ${esc(a.source)} · <a href="${esc(a.url)}" style="color:#9C4A3C;font-weight:bold;text-decoration:none;border-bottom:1px solid #9C4A3C;">${esc(L.readMore)} ↗</a></div>
          </div>`
        )
        .join("");
      return `
      <div style="margin:26px 0 8px 0;">
        <div style="font-size:14px;font-weight:700;color:#9C4A3C;border-bottom:2px solid #1D2E44;padding-bottom:6px;">
          ${esc(sec.title)}
        </div>
        ${items}
      </div>`;
    })
    .join("");

  return `<!doctype html>
<html lang="${lang}" dir="${dir}">
<body style="margin:0;padding:0;background:#FBF8F1;">
  <div style="max-width:600px;margin:0 auto;padding:28px 22px;background:#FBF8F1;font-family:'Cairo','Segoe UI',Tahoma,Arial,sans-serif;color:#1B2635;">
    <div style="border-bottom:3px solid #1D2E44;padding-bottom:12px;margin-bottom:8px;">
      <div style="font-family:Georgia,'Times New Roman',serif;font-size:26px;font-weight:700;color:#1D2E44;">Dial<span style="color:#9C4A3C;">Syria</span></div>
      <div style="font-size:12px;color:#5C6672;">${esc(L.tagline)} · ${esc(today)}</div>
    </div>
    ${rendered || `<div style="padding:20px 0;color:#5C6672;font-size:14px;">—</div>`}
    <div style="border-top:2px solid #1D2E44;margin-top:24px;padding-top:14px;font-size:12px;color:#5C6672;text-align:center;">
      <a href="${esc(manageUrl)}" style="color:#1D2E44;font-weight:700;text-decoration:none;border-bottom:1px solid #9C4A3C;">${esc(L.manage)}</a>
    </div>
  </div>
</body>
</html>`;
}

export interface DigestSection {
  title: string;
  items: ArticleRow[];
  /** وسْم كل خبر بتصنيفه (قسم سوريا فقط) */
  tagItems?: boolean;
}

/**
 * النموذج الجديد (بقرار المالك):
 * قسم سوريا ثابت لكل مشترك (داخلياً وخارجياً)
 * + قسم عالمي واحد لكل موضوع اختاره (أهم الأخبار العالمية فيه).
 */
export async function pickSections(
  env: Env,
  lang: "ar" | "en",
  topics: Topic[],
  cutoff: string
): Promise<DigestSection[]> {
  const L = S[lang];
  const sections: DigestSection[] = [];

  const syria = await env.DB.prepare(
    `SELECT id, title, summary, url, source, topic, scope, published_at
     FROM articles
     WHERE fetched_at > ? AND (scope = 'syria' OR title LIKE '%سوري%')
     ORDER BY published_at DESC
     LIMIT 8`
  )
    .bind(cutoff)
    .all<ArticleRow>();
  if (syria.results.length) {
    sections.push({ title: L.first, items: syria.results, tagItems: true });
  }

  for (const t of topics) {
    const rows = await env.DB.prepare(
      `SELECT id, title, summary, url, source, topic, scope, published_at
       FROM articles
       WHERE topic = ? AND scope = 'global' AND fetched_at > ? AND title NOT LIKE '%سوري%'
       ORDER BY published_at DESC
       LIMIT 5`
    )
      .bind(t, cutoff)
      .all<ArticleRow>();
    if (rows.results.length) {
      sections.push({ title: `${TOPIC_NAMES[lang][t]} — ${L.world}`, items: rows.results });
    }
  }

  return sections;
}

/** نسخة نصية لتيليجرام — بلا روابط: ترقيم + تصنيف + فواصل، عنوان فمصدر فملخص */
export function digestText(lang: "ar" | "en", sections: DigestSection[]): string {
  const L = S[lang];
  const today = new Date().toLocaleDateString(lang === "ar" ? "ar-SY-u-nu-latn" : "en-GB", {
    year: "numeric", month: "long", day: "numeric",
  });
  const heavy = "━━━━━━━━━━━━━━━━━━";
  const light = "────────────────";
  let out = `🗞 DialSyria — ${L.subject}\n${today}\n${heavy}\n`;
  for (const sec of sections) {
    out += `\n■ ${sec.title}\n${light}\n`;
    sec.items.forEach((a, i) => {
      const label = sec.tagItems ? `[${TOPIC_NAMES[lang][a.topic as Topic] || a.topic}] ` : "";
      out += `${i + 1}. ${label}${a.title}\n`;
      const s = a.summary ? a.summary.slice(0, 200) + (a.summary.length > 200 ? "…" : "") : "";
      out += `   ${a.source}${s ? " · " + s : ""}\n`;
    });
  }
  return out;
}

export async function sendEmail(env: Env, to: string, subject: string, html: string): Promise<boolean> {
  if (!env.BREVO_API_KEY || !env.SENDER_EMAIL) return false;
  try {
    const res = await fetch("https://api.brevo.com/v3/smtp/email", {
      method: "POST",
      headers: { "api-key": env.BREVO_API_KEY, "content-type": "application/json" },
      body: JSON.stringify({
        sender: { email: env.SENDER_EMAIL, name: "DialSyria" },
        to: [{ email: to }],
        subject,
        htmlContent: html,
      }),
      signal: AbortSignal.timeout(12000),
    });
    return res.ok;
  } catch {
    return false;
  }
}

export interface DigestResult {
  hour: number;
  due: number;
  sent: number;
  skipped_no_articles: number;
  failed_sends: number;
  skipped_no_provider: number;
  details: { email: string; status: string }[];
}

export async function runDigest(env: Env, broadcast = false): Promise<DigestResult> {
  const now = nowISO();
  const hour = damascusHour();
  const todayStart = damascusTodayStartISO();

  // lazily expire trials
  await env.DB.prepare("UPDATE subscribers SET status='expired' WHERE status='trial' AND trial_ends_at IS NOT NULL AND trial_ends_at < ?").bind(now).run();

  const hourFilter = broadcast ? "" : "s.delivery_hour = ? AND";
  const due = await env.DB.prepare(
    `SELECT s.id, s.email, s.language, s.telegram_chat_id,
            (SELECT GROUP_CONCAT(t.topic, ',') FROM subscriber_topics t WHERE t.subscriber_id = s.id) AS topics_csv
     FROM subscribers s
     WHERE ${hourFilter}
       ((s.status='trial' AND (s.trial_ends_at IS NULL OR s.trial_ends_at > ?))
         OR (s.status='active' AND (s.expires_at IS NULL OR s.expires_at > ?)))
       AND (s.last_digest_at IS NULL OR s.last_digest_at < ?)
     LIMIT 200`
  )
    .bind(...(broadcast ? [now, now, todayStart] : [hour, now, now, todayStart]))
    .all<SubRow>();

  const result: DigestResult = {
    hour, due: due.results.length, sent: 0,
    skipped_no_articles: 0, failed_sends: 0, skipped_no_provider: 0, details: [],
  };

  const cutoff = new Date(Date.now() - 24 * 3600 * 1000).toISOString();

  for (const s of due.results) {
    const topics = (s.topics_csv || "").split(",").filter(Boolean) as Topic[];
    if (!topics.length) continue;

    const lang = (s.language === "en" ? "en" : "ar") as "ar" | "en";
    const sections = await pickSections(env, lang, topics, cutoff);
    const picked = sections.flatMap((sec) => sec.items);

    let status = "sent";
    if (!picked.length) {
      status = "no_new_articles";
      result.skipped_no_articles++;
    } else if (s.telegram_chat_id && env.TELEGRAM_BOT_TOKEN) {
      const ok = await tgSendLong(env, s.telegram_chat_id, digestText(lang, sections));
        if (ok) {
          status = "telegram_sent";
          result.sent++;
        } else {
          status = "telegram_failed";
          result.failed_sends++;
        }
      } else if (env.BREVO_API_KEY && env.SENDER_EMAIL) {
        const manageUrl = siteUrl(env) + "/manage?token=" + (await lookupToken(env, s.id));
        const html = digestHtml(lang, sections, manageUrl);
        const topicLabels = topics.map((x) => TOPIC_NAMES[lang][x]).join(" · ");
        const subject = `${S[lang].subject} — ${topicLabels}`;
        const ok = await sendEmail(env, s.email, subject, html);
        if (!ok) {
          status = "send_failed";
          result.failed_sends++;
        } else {
          result.sent++;
        }
      } else {
        status = "no_provider";
        result.skipped_no_provider++;
      }

    await env.DB.batch([
      ...(status === "sent" || status === "telegram_sent" ? [env.DB.prepare("UPDATE subscribers SET last_digest_at = ? WHERE id = ?").bind(now, s.id)] : []),
      env.DB.prepare(
        "INSERT INTO digests (id, subscriber_id, sent_at, topics, articles_count, status) VALUES (?, ?, ?, ?, ?, ?)"
      ).bind(uuid(), s.id, now, topics.join(","), picked.length, status),
    ]);
    result.details.push({ email: s.email, status });
  }

  return result;
}

async function lookupToken(env: Env, subId: string): Promise<string> {
  const row = await env.DB.prepare("SELECT magic_token FROM subscribers WHERE id = ?").bind(subId).first<{ magic_token: string | null }>();
  return row?.magic_token || "";
}
