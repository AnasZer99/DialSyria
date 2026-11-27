# رقعة `functions/_middleware.ts` — وضع Staging لـRSS-First (جاهزة للتطبيق اليدوي)

**الحالة:** الملف محمي من الكتابة في بيئة التنفيذ (`permission denied: edit`). هذا هو **المحتوى الكامل النهائي** للملف؛ استبدل محتواه بالكامل ثم شغّل الاختبارات (اختبارات `tests/rss-staging.test.mjs` مُرحّلة وستُفعَّل تلقائيًا فور التطبيق).

```ts
import { type Env, fail, stagingAllowlistsValid } from './api/_lib';

// The marker is installed only after the operator independently verifies the
// staging database. Requests never create it. D1 does not expose its bound UUID
// to a Worker; remote binding verification is still required before migration.
const productionDatabaseId='44b3a09f-8f64-4ea0-81e1-d79bc4af7575';
const stagingSiteUrl='https://dialsyria-staging.pages.dev';

async function stagingDatabaseVerified(env:Env):Promise<Response|null>{
  const id=(env.STAGING_D1_ID || '').toLowerCase();
  if(!env.DB || !/^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/.test(id) || id===productionDatabaseId)return fail('staging database isolation not verified',503);
  try{
    const marker=await env.DB.prepare('SELECT count FROM rate_limits WHERE key=? AND window=?').bind('staging-db:'+id,'staging-only').first<{count:number}>();
    return marker?.count===1?null:fail('staging database isolation not verified',503);
  }catch{return fail('staging database isolation not verified',503);}
}

export async function onRequest({request,env,next}:{request:Request;env:Env;next:()=>Promise<Response>}):Promise<Response>{
  const url=new URL(request.url);
  const stagingHost=url.hostname==='dialsyria-staging.pages.dev' || url.hostname.endsWith('.dialsyria-staging.pages.dev');
  // RSS-only staging mode: a narrower protection path for the simplified MVP.
  // It runs only on the staging host and its deployment subdomains, never
  // requires the legacy Telegram pilot credentials, and exposes only the three
  // news MVP endpoints. Everything else is refused.
  if(env.RSS_STAGING_MODE==='1'){
    if(!stagingHost)return fail('rss staging mode is restricted to dialsyria-staging.pages.dev',503);
    if(env.STAGING_PILOT_MODE!=='1' || env.SITE_URL!==stagingSiteUrl || env.ALLOW_MOCK_DISCOVERY!=='0' || env.TELEGRAM_DELIVERY_ENABLED!=='0' || env.BETA_SCHEDULED_DELIVERY_ENABLED!=='0')return fail('rss staging protection is not configured',503);
    const blocked=await stagingDatabaseVerified(env);
    if(blocked)return blocked;
    if(url.pathname.startsWith('/api/')){
      const allowed=(request.method==='GET'&&url.pathname==='/api/news')
        ||(request.method==='POST'&&(url.pathname==='/api/ingest'||url.pathname==='/api/digest'));
      if(!allowed)return fail('route not available in rss staging mode',404);
    }
    return next();
  }
  if(stagingHost && env.STAGING_PILOT_MODE!=='1')return fail('staging protection is not configured',503);
  if(env.STAGING_PILOT_MODE!=='1')return next();
  if(!stagingHost || env.SITE_URL!=='https://dialsyria-staging.pages.dev' || env.ALLOW_MOCK_DISCOVERY!=='0' || !['0','1'].includes(env.TELEGRAM_DELIVERY_ENABLED || '') || !stagingAllowlistsValid(env))return fail('staging protection is not configured',503);
  if(!/^[A-Za-z0-9_]{5,32}$/.test(env.TELEGRAM_BOT || '') || (env.TELEGRAM_BOT || '').toLowerCase()==='dialsyriabot' || !/^\d{6,15}:[A-Za-z0-9_-]{30,}$/.test(env.TELEGRAM_BOT_TOKEN || '') || !/^[A-Za-z0-9_-]{32,256}$/.test(env.TELEGRAM_WEBHOOK_SECRET || '') || (env.ADMIN_PASSWORD || '').length<24)return fail('staging protection is not configured',503);
  // The staging pilot must not issue or accept legacy management tokens in URLs.
  if(url.searchParams.has('token') || /^\/api\/(?:subscribe|login|me|telegram\/link)\/?$/.test(url.pathname))return fail('legacy token access disabled on staging',403);
  const blocked=await stagingDatabaseVerified(env);
  if(blocked)return blocked;
  return next();
}
```

## ما يفعله هذا المسار الجديد (RSS_STAGING_MODE='1')

1. يعمل **فقط** على `dialsyria-staging.pages.dev` ونطاقات النشر الفرعية `*.dialsyria-staging.pages.dev`؛ يرفض 503 على أي نطاق آخر.
2. يشترط `STAGING_PILOT_MODE=1` + `SITE_URL` المطابق لـStaging + `ALLOW_MOCK_DISCOVERY=0` + `TELEGRAM_DELIVERY_ENABLED=0` + `BETA_SCHEDULED_DELIVERY_ENABLED=0`.
3. لا يشترط بوت Telegram ولا قوائم Beta ولا `ADMIN_PASSWORD` (بخلاف مسار Beta القديم الذي يبقى كما هو).
4. يتحقق من عزل قاعدة D1: `STAGING_D1_ID` بصيغة UUID ≠ معرف Production + علامة `staging-db:<id>` داخل القاعدة (نفس الفحص القديم، دون تجاوزه).
5. يسمح من API فقط بـ: `GET /api/news` و`POST /api/ingest` و`POST /api/digest`؛ ويمنع بقية مسارات API (Beta/Telegram/التسجيل/الإدارة/الاهتمامات) بـ404. تحقق `CRON_SECRET` يبقى داخل مساري `ingest`/`digest` كما هو (الوسيط لا يتجاوزهما).
6. `Digest` يبقى معطلًا تحت `STAGING_PILOT_MODE=1`: `runDigest` يعيد صفر إرسال دون أي اتصال بمزود (سلوك قائم).
7. حماية Beta القديمة وحماية Production غير متأثرتين (الفرع الجديد يعمل فقط عند `RSS_STAGING_MODE='1'`).

## متغيرات Staging المطلوبة (Pages → Variables)

`RSS_STAGING_MODE=1` · `STAGING_PILOT_MODE=1` · `SITE_URL=https://dialsyria-staging.pages.dev` · `STAGING_D1_ID=<معرف قاعدة Staging>` · `TELEGRAM_DELIVERY_ENABLED=0` · `BETA_SCHEDULED_DELIVERY_ENABLED=0` · `ALLOW_MOCK_DISCOVERY=0` · `CRON_SECRET=<جديد>`
(بدون أي من: `TELEGRAM_BOT_TOKEN`، `TELEGRAM_WEBHOOK_SECRET`، `TELEGRAM_BOT`، `BETA_ALLOWED_TELEGRAM_IDS`، `TELEGRAM_TEST_CHAT_IDS`، مفاتيح البريد.)

## متطلبات قاعدة البيانات (تنفيذ يدوي واحد، بلا حذف)

```sql
INSERT INTO rate_limits (key, window, count) VALUES ('staging-db:<STAGING_D1_ID>', 'staging-only', 1);
```
