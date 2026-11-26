import { type Env, nowISO, stagingAllowlistsValid } from './_lib';

const browserCookie = 'ds_beta_browser';
const sessionCookie = 'ds_beta_session';
export const randomSecret = () => Array.from(crypto.getRandomValues(new Uint8Array(24)), b=>b.toString(16).padStart(2,'0')).join('');
export async function hash(value:string):Promise<string> {
  return Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(value))),b=>b.toString(16).padStart(2,'0')).join('');
}
export function getCookie(request:Request,name:string):string {
  return (request.headers.get('cookie') || '').split(';').map(x=>x.trim()).find(x=>x.startsWith(name+'='))?.slice(name.length+1) || '';
}
export function cookie(request:Request,name:string,value:string,seconds:number):string {
  const secure=new URL(request.url).protocol==='https:';
  return `${name}=${value}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${seconds}${secure?'; Secure':''}`;
}
export function allowedOrigin(request:Request):boolean {
  const url=new URL(request.url);
  if(url.protocol!=='https:' && !(url.protocol==='http:' && ['localhost','127.0.0.1','[::1]'].includes(url.hostname)))return false;
  return request.headers.get('origin')===url.origin && request.headers.get('sec-fetch-site')!=='cross-site';
}
export async function sessionOwner(request:Request,env:Env):Promise<string|null> {
  if(!stagingAllowlistsValid(env))return null;
  if(!['GET','HEAD'].includes(request.method) && !allowedOrigin(request))return null;
  const secret=getCookie(request,sessionCookie);
  if(!/^[a-f0-9]{48}$/.test(secret))return null;
  const row=await env.DB.prepare('SELECT s.subscriber_id,b.chat_id FROM beta_sessions s JOIN beta_identities b ON b.subscriber_id=s.subscriber_id WHERE s.session_hash=? AND s.expires_at>?').bind(await hash(secret),nowISO()).first<{subscriber_id:string;chat_id:string}>();
  const invited=new Set((env.BETA_ALLOWED_TELEGRAM_IDS || '').split(',').map(x=>x.trim()).filter(Boolean));
  return row && invited.has(row.chat_id)?row.subscriber_id:null;
}
export { browserCookie, sessionCookie };

// Atomic per-IP limit; unknown client addresses share a conservative global bucket.
export async function betaLimit(env:Env,key:string,limit:number):Promise<boolean> {
  const window=nowISO().slice(0,13);
  const row=await env.DB.prepare('INSERT INTO rate_limits (key,window,count) VALUES (?,?,1) ON CONFLICT(key) DO UPDATE SET count=count+1 WHERE count<? RETURNING count').bind(`beta:${key}:${window}`,window,limit).first<{count:number}>();
  return !!row;
}

// A forwarded start link alone never completes authentication. The Telegram user
// must compare the browser code and explicitly confirm in their private chat.
export async function claimBetaStart(env:Env,token:string,chatId:string):Promise<{code:string}|null> {
  if(!stagingAllowlistsValid(env))return null;
  if(!/^[a-f0-9]{48}$/.test(token))return null;
  const invited=new Set((env.BETA_ALLOWED_TELEGRAM_IDS || '').split(',').map(x=>x.trim()).filter(x=>/^[1-9]\d*$/.test(x)));
  if(!invited.has(chatId))return null;
  const now=nowISO(), h=await hash(token);
  const row=await env.DB.prepare("UPDATE beta_challenges SET status='claimed',chat_id=? WHERE challenge_hash=? AND status='pending' AND expires_at>? RETURNING display_code").bind(chatId,h,now).first<{display_code:string}>();
  return row?{code:row.display_code}:null;
}
export async function approveBeta(env:Env,token:string,chatId:string):Promise<boolean> {
  if(!/^[a-f0-9]{48}$/.test(token))return false;
  const row=await env.DB.prepare("UPDATE beta_challenges SET status='approved' WHERE challenge_hash=? AND chat_id=? AND status='claimed' AND expires_at>? RETURNING challenge_hash").bind(await hash(token),chatId,nowISO()).first<{challenge_hash:string}>();
  return !!row;
}

// Staging sends no challenge in a URL. Invited users choose the matching browser
// code from a private bot keyboard; only the opaque selector goes to Telegram.
export async function sendStagingChallenges(env:Env,chatId:string):Promise<boolean> {
  if(!env.TELEGRAM_BOT_TOKEN || !stagingAllowlistsValid(env))return false;
  const rows=await env.DB.prepare("SELECT challenge_hash,display_code FROM beta_challenges WHERE status='pending' AND expires_at>? ORDER BY created_at DESC LIMIT 8").bind(nowISO()).all<{challenge_hash:string;display_code:string}>();
  const buttons=rows.results.map(row=>[{text:row.display_code,callback_data:`p_${row.challenge_hash.slice(0,32)}`}]);
  const text=buttons.length?'اختر رمز المقارنة المطابق لما يظهر في متصفحك فقط. إذا لم تبدأ طلب دخول، لا تختر أي رمز.':'لا يوجد طلب دخول صالح. ابدأ من موقع التجربة أولاً.';
  try{const res=await fetch(`https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/sendMessage`,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({chat_id:chatId,text,...(buttons.length?{reply_markup:{inline_keyboard:buttons}}:{})}),signal:AbortSignal.timeout(10000)});return res.ok;}catch{return false;}
}
export async function approveStagingChallenge(env:Env,selector:string,chatId:string):Promise<boolean>{
  if(!stagingAllowlistsValid(env)||!/^[a-f0-9]{32}$/.test(selector))return false;
  const invited=new Set((env.BETA_ALLOWED_TELEGRAM_IDS || '').split(',').map(x=>x.trim()));
  if(!invited.has(chatId))return false;
  const row=await env.DB.prepare("UPDATE beta_challenges SET status='approved',chat_id=? WHERE substr(challenge_hash,1,32)=? AND status='pending' AND expires_at>? RETURNING challenge_hash").bind(chatId,selector,nowISO()).first<{challenge_hash:string}>();
  return !!row;
}
export async function sendBetaConfirmation(env:Env,chatId:string,token:string,code:string):Promise<boolean> {
  if(!env.TELEGRAM_BOT_TOKEN)return false;
  try {
    const res=await fetch(`https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/sendMessage`,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({chat_id:chatId,text:`طلب دخول DialSyria. رمز المقارنة: ${code}\nقارن الرمز مع الرمز المعروض في متصفحك أنت. إذا لم تبدأ الطلب أو اختلف الرمز فلا توافق.`,reply_markup:{inline_keyboard:[[{text:'الرمز مطابق، أوافق على الدخول',callback_data:`b_${token}`}]]}}),signal:AbortSignal.timeout(10000)});
    return res.ok;
  }catch{return false;}
}
