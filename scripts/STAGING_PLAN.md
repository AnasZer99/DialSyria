# DialSyria — خطة Staging ورقع الملفات المحمية (27 نوفمبر 2026)

**تحديث الحالة:** تم تطبيق رقعة `cron-worker/index.js` يدويًا من المالك (إزالة `/api/notify`)؛ بقيت رقع `README.md` و`docs/mvp/*` للمالك لأن الكتابة محجوبة عن الوكيل.

هذا الملف مخصص للمالك لأن `cron-worker/` و`docs/mvp/` و`README.md` وGit محمية من الكتابة في بيئة التنفيذ. كل ما يلي جاهز للنسخ والتنفيذ يدويًا.

## 1. رقعة `cron-worker/index.js` (إزالة Telegram عن جدولة RSS)

استبدل كتلة `scheduled` بالكامل بالتالي:

```js
export default {
  async scheduled(event, env, ctx) {
    const base = (env.SITE_URL || "https://dial-syria.pages.dev").replace(/\/$/, "");
    const headers = { "x-cron-secret": env.CRON_SECRET || "" };

    if (event.cron === "0 1 * * *") {
      // Daily RSS ingestion at 01:00 UTC = 04:00 Damascus (UTC+3, no DST).
      // The ingest route refuses a second clean run for the same Damascus day.
      ctx.waitUntil(ping(base + "/api/ingest", { method: "POST", headers }));
    } else if (event.cron === "7 * * * *") {
      // Digests only. Telegram/Beta routes are intentionally not scheduled here.
      ctx.waitUntil(ping(base + "/api/digest", { method: "POST", headers }));
    }
  },
};
```

`cron-worker/wrangler.jsonc` صحيح بالفعل: `["0 1 * * *", "7 * * * *"]` — لا تغيير.

## 2. اختبارات Cron — مُطبّقة في `tests/scheduled-delivery.test.mjs`

تم تحديث الاختبارات فعليًا في 27 نوفمبر:
- `the RSS cron schedules ingestion and digests only` — يثبت أن `7 * * * *` يستدعي `/api/digest` فقط، و`0 1 * * *` يستدعي `/api/ingest` فقط، ولا `/api/notify` ولا `/api/direct`، وأن `*/30` متقاعد بلا استدعاءات.
- `the RSS cron worker source contains no Telegram or Beta routes` — فحص ثابت لمصدر العامل يمنع رجوع المسارات.
- `scheduler transport errors are caught and reported without leaking secrets` — يفشل `/api/digest` ويتأكد من التقاط الخطأ وعدم تسريب السر.
- تحديث اختبار السجلات ليؤكد غياب أي سجل لـ`/api/notify` أو `/api/direct`.

## 3. رقعة `README.md` (القسمان 3–4 والبنية)

- سطر «مصادر الأخبار»: استبدله بـ
  `مصادر الأخبار: RSS مباشر من 7 ناشرين (سانا، تلفزيون سوريا، نورث برس، BBC عربي، فرانس 24، CNN عربية، الجزيرة نت) → تصنيف حتمي → إزالة تكرار → D1`
- سطر «الإرسال»: `Resend (أساسي) مع Brevo كاحتياط؛ Mock في الاختبارات` وأضف `EMAIL_FROM`/`RESEND_API_KEY`.
- سطر «المجدول»: `Worker منفصل dialsyria-cron — جمع يومي 04:00 دمشق (0 1 UTC) + فحص النشرات كل ساعة عند :07؛ لا يجمع Telegram ولا Beta.`
- أضف في نهاية القسم ملاحظة:
  `التغطية: سياسة/اقتصاد/رياضة/صحة جيدة، والتكنولوجيا والثقافة السورية محدودتان (راجع docs/mvp/03_RSS_SOURCE_AUDIT.md). Staging غير مختبر بعد، والبريد الحقيقي غير مفعّل.`

## 4. تحديثات `docs/mvp/FINAL_MVP_REPORT.md`

استبدل الترويسة والحالة بـ:
```md
**التاريخ:** 27 نوفمبر 2026 · **الفرع:** `feat/rss-mvp-simplification` (منشأ ومرفوع) · **آخر Commit مرجعي:** `0880a5f`

**الحالة:** `LOCAL_IMPLEMENTATION_COMPLETE` — الاختبارات 180/180، البناء وفحص الأنواع ناجحان.
Staging **غير مختبر**، البريد الحقيقي **غير مفعّل**، Telegram/Beta **غير مجدولين** في عامل RSS.
```

ثم:
- قسم الجدولة: ✅ الجدول `0 1 * * *` + `7 * * * *`، ولا `/api/notify` ولا `/api/direct` (بعد تطبيق الرقعة أعلاه).
- قسم Schema: ✅ `schema.sql` يحتوي `ingestion_sources` + فهرسي `articles`؛ ترحيل 0014 بلا فهارس `articles` (السبب: الجدول يُنشأ في schema.sql) — مُختبر بقاعدة جديدة.
- الاختبارات: **180/180**.
- حد الـ100: استبدل الجدول بتفاصيل القياس (أدناه).
- Staging: غير مختبر؛ خطة النشر في القسم 5.

## 5. خطة نشر Staging (تنفيذ لاحق بموافقة؛ لا تنفيذ الآن)

**المتطلبات المسبقة:** حساب Cloudflare، مشروع Pages `dialsyria-staging` موجود، قاعدة `dialsyria-staging-db` منفصلة، عامل Cron اختباري باسم `dialsyria-staging-cron` (لا تلمس `dialsyria-cron` الحالي ولا عامل Beta).

1. **قاعدة D1 منفصلة:** تأكيد أن `dialsyria-staging-db` ليست Production؛ أخذ نسخة احتياطية قبل أي ترحيل.
2. **الترحيلات:** تطبيق `0001…0014` على قاعدة Staging (0014 آمن/متكرر). لا ترحيل على Production.
3. **متغيرات Pages Staging:** `SITE_URL=https://dialsyria-staging.pages.dev`، `CRON_SECRET` جديد، **بدون** `RESEND_API_KEY`/`BREVO_API_KEY`/`EMAIL_FROM` (بريد معطّل)، `TELEGRAM_DELIVERY_ENABLED=0`، `BETA_SCHEDULED_DELIVERY_ENABLED` غير مضبوط.
4. **نشر Pages:** `wrangler pages deploy dist --project-name dialsyria-staging --branch staging` (بعد بناء ناجح).
5. **عامل Cron اختباري:** انسخ `cron-worker` إلى اسم جديد `dialsyria-staging-cron` مع `SITE_URL` الخاص بـStaging و`CRON_SECRET` نفسه؛ `crons: ["0 1 * * *","7 * * * *"]`. لا تعدّل العامل الحالي.
6. **التحقق:** `POST /api/ingest` يدويًا بمفتاح Cron → صفوف في `articles` و`ingestion_runs`/`ingestion_sources`؛ فتح الموقع والتصفية؛ `POST /api/digest` يجب أن يسجل `no_provider` دون إرسال.
7. **إيقاف/تنظيف:** بعد الاختبار، أوقف عامل Staging (أو اتركه معطلاً) ولا تحذف البيانات.

## 6. حد الـ100 — نتيجة القياس (27 نوفمبر 2026)

| المصدر | إجمالي العناصر | خلال 24 ساعة | نطاق التغذية | القديم عند العنصر 100 | القرار |
|---|---|---|---|---|---|
| سانا | 150 | 150 | ~21.5 ساعة | 08:28 اليوم (فقد ~10 ساعات) | **سقف 200** (يحفظ 150 كاملة) |
| تلفزيون سوريا | 118 | 50 | ~46 ساعة | 03:53 أمس (~39 ساعة) | 100 كافٍ |
| نورث برس | 9 | 8 | ~22 ساعة | — | 100 كافٍ |
| BBC عربي | 25 | 10 | متداخل | — | 100 كافٍ |
| فرانس 24 | 24 | 24 | ~6 ساعات | — | 100 كافٍ |
| CNN عربية | 20 | 20 | ~8 ساعات | — | 100 كافٍ |
| الجزيرة نت | 25 | 25 | ~2 ساعات | — | 100 كافٍ |

**قيد المصدر نفسه:** سانا تعرض 150 عنصرًا فقط (~21.5 ساعة)؛ حتى مع سقف 200 تبقى ~2.5 ساعة يوميًا غير متاحة من التغذية. لا ادعاء بتغطية كاملة.

## 7. أوامر Git اليدوية (بعد تطبيق الرقع)

```powershell
git status
git add functions/api/_rss_sources.ts functions/api/_ingest.ts tests/demo.test.mjs tests/rss-mvp.test.mjs tests/zz-live-audit-probe.test.mjs cron-worker/index.js tests/scheduled-delivery.test.mjs README.md docs/mvp/FINAL_MVP_REPORT.md docs/mvp/PROGRESS.md
git commit -m "fix(rss): cap SANA feed at 200, isolate Telegram from RSS cron, refresh docs"
git push origin feat/rss-mvp-simplification
```

> لا تستخدم `git add -A`: الملفات غير المتتبعة القديمة (الأرشيفات، `STAGING_CHECKPOINT.json`، `opencode.jsonc`، `wrangler.staging.example.json`) ليست جزءًا من MVP.
