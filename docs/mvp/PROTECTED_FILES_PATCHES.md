# ملفات محمية — التعديلات المطلوبة من المالك

البيئة الحالية ترفض الكتابة في هذه الملفات (`permission.rejected`). لا تُعدَّل تلقائيًا. القائمة قصيرة ودقيقة.

## 1) `cron-worker/index.js`

استبدل كتلة الشرط الأولى داخل `scheduled` بما يلي (واحتفظ بالبقية كما هي):

```js
if (event.cron === "0 1 * * *") {
  // Daily RSS ingestion at 01:00 UTC = 04:00 Damascus (UTC+3, no DST).
  // The ingest route refuses a second clean run for the same Damascus day.
  ctx.waitUntil(ping(base + "/api/ingest", { method: "POST", headers }));
} else if (event.cron === "7 * * * *") {
  // Hourly: send digests whose Damascus hour matches; notify route stays in
  // prepare mode unless TELEGRAM_DELIVERY_ENABLED is explicitly set.
  ctx.waitUntil(ping(base + "/api/digest", { method: "POST", headers }));
  ctx.waitUntil(ping(base + "/api/notify", { method: "POST", headers: { ...headers, "content-type": "application/json" }, body: JSON.stringify({ mode: "deliver" }) }));
}
```

**الأثر:** يزيل استدعاء `/api/direct` (Beta/الاهتمامات الشخصية) من جدول MVP، ويجعل الجمع يوميًا 04:00 دمشق بدل كل 30 دقيقة.

## 2) `cron-worker/wrangler.jsonc`

```jsonc
"triggers": {
  "crons": ["0 1 * * *", "7 * * * *"]
}
```

## 3) `schema.sql`

أضف في نهاية الملف (مطابقة لما يطبّقه الترحيل 0014 على قواعد قائمة):

```sql
-- Per-source observability for the daily RSS run (see migrations/0014).
CREATE TABLE IF NOT EXISTS ingestion_sources (
  run_started_at TEXT NOT NULL,
  source_id TEXT NOT NULL,
  source_name TEXT NOT NULL,
  status TEXT NOT NULL,
  http_status INTEGER,
  parsed INTEGER NOT NULL DEFAULT 0,
  recent INTEGER NOT NULL DEFAULT 0,
  inserted INTEGER NOT NULL DEFAULT 0,
  error TEXT,
  PRIMARY KEY (run_started_at, source_id)
);
CREATE INDEX IF NOT EXISTS idx_ingestion_sources_run ON ingestion_sources(run_started_at);
CREATE INDEX IF NOT EXISTS idx_articles_scope_topic ON articles(scope, topic, published_at DESC);
CREATE INDEX IF NOT EXISTS idx_articles_fetched ON articles(fetched_at);
```

> ملاحظة: فهارس `articles` تعمل فقط بعد إنشاء الجدول في نفس الملف (وهو كذلك)، ولا تصلح داخل الترحيل 0014 لأن الجدول غير موجود بعد في تلك المرحلة.

## 4) نقل التوثيق `scripts/mvp/` → `docs/mvp/`

```powershell
New-Item -ItemType Directory -Force docs\mvp\design-previews | Out-Null
Copy-Item scripts\mvp\*.md docs\mvp\
Copy-Item scripts\mvp\design-previews\* docs\mvp\design-previews\
# بعد التأكد من نجاح النقل:
Remove-Item scripts\mvp -Recurse
```

(النسخ أولًا ثم الحذف يحافظ على النسخة الأصلية حتى التحقق.)

## 5) Git (الفرع فقط)

```powershell
git checkout -b feat/rss-mvp-simplification
git add functions/api/_ingest.ts functions/api/news.ts functions/api/_digest.ts functions/api/_lib.ts `
        functions/api/_rss_sources.ts functions/api/_classify.ts functions/api/_email.ts `
        migrations/0014_ingestion_sources.sql tests/rss-mvp.test.mjs tests/zz-live-audit-probe.test.mjs `
        scripts/discovery-runtime.mjs scripts/mvp src/App.tsx src/pages/Home.tsx src/pages/Subscribe.tsx `
        src/lib/api.ts src/lib/i18n.ts src/styles.css
git commit -m "feat: RSS-first MVP (daily ingestion, topic coverage, email digest, news UI)"
git push -u origin feat/rss-mvp-simplification
```

**تحذير قبل الدفع:** تحقق أن الدفع إلى هذا الفرع لا يفعّل نشرًا إنتاجيًا (Cloudflare Pages/Workers build hooks). المشروع لا يحتوي إعداد نشر تلقائي في المستودع، لكن راجع إعدادات Cloudflare قبل الدفع.

## 6) اسم اختبار الكتالوج

`tests/zz-live-audit-probe.test.mjs` يحتوي الآن **اختبار كتالوج حقيقيًا** (لا شبكة). يُفضّل إعادة تسميته إلى `tests/rss-catalog.test.mjs`:
```powershell
git mv tests/zz-live-audit-probe.test.mjs tests/rss-catalog.test.mjs
```
