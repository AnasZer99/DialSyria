# رقعة `functions/_middleware.ts` — فتح مسارات رحلة MVP على Staging

**الحالة:** الملف محمي من الكتابة في بيئة التنفيذ. هذه هي النسخة الكاملة النهائية — استبدل محتوى الملف بها ثم شغّل `npm test` (اختبارات `tests/rss-mvp-journey.test.mjs` ستتحقق من السلوك الجديد مباشرة لأنها تختبر الوسيط الفعلي).

**التغيير الوحيد عن النسخة الحالية:** استخراج قائمة المسارات المسموحة إلى `rssRouteAllowed()`، وإضافة مسارات رحلة MVP الجديدة **فقط عند** `RSS_MVP_ROUTES='1'` (إعداد مخصص منفصل، مغلق افتراضيًا). حماية Staging العامة وفحص عزل قاعدة البيانات وحماية Production كما هي دون أي تغيير.

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

/** RSS staging API allowlist: exact method+path pairs only (never /api/* wide). */
function rssRouteAllowed(env:Env,method:string,pathname:string):boolean{
  if(method==='GET'&&pathname==='/api/news')return true;
  if(method==='POST'&&(pathname==='/api/ingest'||pathname==='/api/digest'))return true;
  // MVP journey routes stay closed until RSS_MVP_ROUTES is explicitly enabled;
  // admin endpoints remain authenticated by their own backend handlers.
  if(env.RSS_MVP_ROUTES==='1'){
    if(method==='POST'&&(pathname==='/api/subscribe'||pathname==='/api/telegram-mvp'||pathname==='/api/admin/login'))return true;
    if((method==='GET'||method==='POST')&&pathname==='/api/admin/subscribers')return true;
  }
  return false;
}

export async function onRequest({request,env,next}:{request:Request;env:Env;next:()=>Promise<Response>}):Promise<Response>{
  const url=new URL(request.url);
  const stagingHost=url.hostname==='dialsyria-staging.pages.dev' || url.hostname.endsWith('.dialsyria-staging.pages.dev');
  // RSS-only staging mode: a narrower protection path for the simplified MVP.
  // It runs only on the staging host and its deployment subdomains, never
  // requires the legacy Telegram pilot credentials, and exposes only the
  // allow-listed news MVP endpoints. Everything else is refused.
  if(env.RSS_STAGING_MODE==='1'){
    if(!stagingHost)return fail('rss staging mode is restricted to dialsyria-staging.pages.dev',503);
    if(env.STAGING_PILOT_MODE!=='1' || env.SITE_URL!==stagingSiteUrl || env.ALLOW_MOCK_DISCOVERY!=='0' || env.TELEGRAM_DELIVERY_ENABLED!=='0' || env.BETA_SCHEDULED_DELIVERY_ENABLED!=='0')return fail('rss staging protection is not configured',503);
    const blocked=await stagingDatabaseVerified(env);
    if(blocked)return blocked;
    if(url.pathname.startsWith('/api/') && !rssRouteAllowed(env,request.method,url.pathname))return fail('route not available in rss staging mode',404);
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

## متغيرات Staging الإضافية لتشغيل الرحلة (بعد تطبيق الرقعة)

`RSS_MVP_ROUTES=1` · `RSS_MVP_MODE=1` · `TELEGRAM_MVP_BOT=<اسم بوت MVP>` · `TELEGRAM_MVP_BOT_TOKEN=<توكن البوت — Secret>` · `TELEGRAM_MVP_WEBHOOK_SECRET=<سر Webhook — Secret>` · `ADMIN_PASSWORD=<كلمة مرور قوية — Secret>`

- عمليات الإدارة تبقى محمية بـ`checkAdmin` في الـBackend نفسه (الوسيط يفتح الوصول للطلب فقط).
- لا يُفتح أي مسار آخر، ولا يعود Telegram Beta القديم للعمل.
