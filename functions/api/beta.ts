import { type Handler, clientIp, fail, isPrivateChatId, json, nowISO, readJson, stagingAllowlistsValid, uuid } from './_lib';
import { allowedOrigin, betaLimit, browserCookie, cookie, getCookie, hash, randomSecret, sessionCookie, sessionOwner } from './_beta';
import { normalizeInterest } from './interests';
import { countBetaReadyNotifications } from './_notify';
import type { Database } from './_discovery';

const CHALLENGE_SECONDS=600, SESSION_SECONDS=7*24*3600;
type Challenge={challenge_hash:string;browser_hash:string;interests_json:string;status:string;chat_id:string|null;expires_at:string};
function withCookie(response:Response,value:string):Response {response.headers.append('Set-Cookie',value);return response;}
function validateInterests(value:unknown):string[]|null {
  if(!Array.isArray(value) || value.length>3)return null;
  const result:string[]=[];const seen=new Set<string>();
  for(const item of value){
    if(typeof item!=='string' || /[\p{Cc}\p{Cs}]/u.test(item))return null;
    const text=item.normalize('NFKC').trim().replace(/\s+/gu,' '), norm=normalizeInterest(text);
    if(Array.from(text).length<3 || Array.from(text).length>300 || Array.from(norm.replace(/\s/g,'')).length<3 || seen.has(norm))return null;
    seen.add(norm);result.push(text);
  }
  return result;
}
export const onRequestGet:Handler=async({request,env})=>{
  const id=await sessionOwner(request,env);if(!id)return fail('not authenticated',401);
  const sub=await env.DB.prepare('SELECT s.status,s.expires_at,s.telegram_chat_id,b.notifications_enabled_at,b.chat_id FROM subscribers s JOIN beta_identities b ON b.subscriber_id=s.id WHERE s.id=?').bind(id).first<{status:string;expires_at:string|null;telegram_chat_id:string|null;notifications_enabled_at:string|null;chat_id:string}>();
  if(!sub)return fail('not authenticated',401);
  const interests=await env.DB.prepare("SELECT i.id,i.text,i.created_at,i.updated_at,COALESCE(j.status,'pending') AS monitoring_status,j.last_attempt_at,j.next_attempt_at,COALESCE(j.source_count,0) AS source_count,j.error_code FROM subscriber_interests i LEFT JOIN interest_monitor_jobs j ON j.interest_key=i.normalized_text WHERE i.subscriber_id=? ORDER BY i.created_at,i.id").bind(id).all();
  const last=await env.DB.prepare("SELECT title,url,sent_at FROM notifications WHERE subscriber_id=? AND status='sent' ORDER BY sent_at DESC LIMIT 1").bind(id).first<{title:string;url:string;sent_at:string}>();
  const readyCount=await countBetaReadyNotifications(env.DB as unknown as Database,id,{invited:env.BETA_ALLOWED_TELEGRAM_IDS || '',recipients:env.TELEGRAM_TEST_CHAT_IDS || '',freshnessHours:Number(env.BETA_FRESHNESS_HOURS || 72)});
  return json({status:sub.status,expiresAt:sub.expires_at,telegramConnected:!!sub.telegram_chat_id && isPrivateChatId(sub.telegram_chat_id) && sub.telegram_chat_id===sub.chat_id,notificationsEnabled:!!sub.notifications_enabled_at && (sub.status==='active'||sub.status==='trial') && (!sub.expires_at || sub.expires_at>nowISO()),lastNotification:last,readyCount,interests:interests.results});
};
export const onRequestPost:Handler=async({request,env})=>{
  if(!allowedOrigin(request))return fail('invalid origin',403);
  if(!stagingAllowlistsValid(env))return fail('invalid staging allowlists',503);
  const body=await readJson<{action?:unknown;interests?:unknown}>(request);
  if(body.action==='begin'){
    if(!await betaLimit(env,`begin:${clientIp(request)}`,20))return fail('rate limit',429);
    const interests=validateInterests(body.interests);if(!interests)return fail('invalid interests');
    const bot=env.TELEGRAM_BOT || '';
    if(!/^[A-Za-z0-9_]{5,32}$/.test(bot))return fail('Telegram bot is not configured',503);
    if(!(env.BETA_ALLOWED_TELEGRAM_IDS || '').split(',').some(x=>/^[1-9]\d*$/.test(x.trim())))return fail('beta invitations are not configured',503);
    const token=randomSecret(),browser=randomSecret();
    let code='';
    for(let i=0;i<8;i++){
      const candidate=String(crypto.getRandomValues(new Uint32Array(1))[0]%1000000).padStart(6,'0');
      // Atomic, non-reused pilot codes prevent two simultaneous browsers from
      // presenting an indistinguishable selection in the bot keyboard.
      const reserved=env.STAGING_PILOT_MODE==='1' ? await env.DB.prepare('INSERT OR IGNORE INTO rate_limits(key,window,count) VALUES(?,?,1)').bind('staging-code:'+candidate,'staging-code').run() : {meta:{changes:1}};
      if(reserved.meta.changes){code=candidate;break;}
    }
    if(!code)return fail('could not create a unique challenge',503);
    const now=nowISO(),expires=new Date(Date.now()+CHALLENGE_SECONDS*1000).toISOString();
    await env.DB.prepare('DELETE FROM beta_challenges WHERE expires_at<=?').bind(now).run();
    await env.DB.prepare('DELETE FROM beta_sessions WHERE expires_at<=?').bind(now).run();
    await env.DB.prepare('INSERT INTO beta_challenges(challenge_hash,browser_hash,display_code,interests_json,created_at,expires_at) VALUES(?,?,?,?,?,?)').bind(await hash(token),await hash(browser),code,JSON.stringify(interests),now,expires).run();
    return withCookie(json(env.STAGING_PILOT_MODE==='1'?{bot,code,expiresAt:expires,staging:true}:{bot,token,code,expiresAt:expires}),cookie(request,browserCookie,browser,CHALLENGE_SECONDS));
  }
  if(body.action==='poll'){
    if(!await betaLimit(env,`poll:${clientIp(request)}`,900))return fail('rate limit',429);
    const browser=getCookie(request,browserCookie);if(!/^[a-f0-9]{48}$/.test(browser))return fail('challenge expired',410);
    const row=await env.DB.prepare('SELECT challenge_hash,browser_hash,interests_json,status,chat_id,expires_at FROM beta_challenges WHERE browser_hash=? ORDER BY created_at DESC LIMIT 1').bind(await hash(browser)).first<Challenge>();
    if(!row || row.expires_at<=nowISO() || row.status==='consumed')return fail('challenge expired',410);
    if(row.status!=='approved' || !row.chat_id)return json({status:row.status});
    const accounts=await env.DB.prepare('SELECT id FROM subscribers WHERE telegram_chat_id=? LIMIT 2').bind(row.chat_id).all<{id:string}>();
    if(accounts.results.length>1)return fail('Telegram account conflict; contact support',409);
    const identity=await env.DB.prepare('SELECT subscriber_id FROM beta_identities WHERE chat_id=?').bind(row.chat_id).first<{subscriber_id:string}>();
    if(identity && (accounts.results.length!==1 || identity.subscriber_id!==accounts.results[0].id))return fail('Telegram account conflict; contact support',409);
    const interests=validateInterests(JSON.parse(row.interests_json));
    if(!interests)return fail('invalid saved interests',500);
    if(!identity && !accounts.results.length && !interests.length)return fail('new account needs at least one interest',400);
    // Claim once before creating a session; parallel polls cannot both authenticate.
    const claimed=await env.DB.prepare("UPDATE beta_challenges SET status='consumed' WHERE challenge_hash=? AND browser_hash=? AND status='approved' AND expires_at>? RETURNING challenge_hash").bind(row.challenge_hash,row.browser_hash,nowISO()).first();
    if(!claimed)return fail('challenge already used',410);
    const now=nowISO(), chatHash=await hash(row.chat_id), deterministicId='beta_'+chatHash;
    const existing=identity?.subscriber_id || accounts.results[0]?.id;
    const id=existing || deterministicId;
    if(!existing){
      const configured=Number(env.BETA_DURATION_DAYS || 30),days=Number.isInteger(configured) && configured>=1 && configured<=365?configured:30;
      const expires=new Date(Date.now()+days*86400000).toISOString();
      await env.DB.prepare("INSERT OR IGNORE INTO subscribers(id,email,telegram_chat_id,language,status,expires_at,created_at) SELECT ?,?,?,'ar','paused',?,? WHERE NOT EXISTS (SELECT 1 FROM subscribers WHERE telegram_chat_id=?)").bind(id,`beta-${chatHash}@example.invalid`,row.chat_id,expires,now,row.chat_id).run();
    }
    const owner=await env.DB.prepare('SELECT id FROM subscribers WHERE id=? AND telegram_chat_id=?').bind(id,row.chat_id).first<{id:string}>();
    if(!owner)return fail('Telegram account conflict; contact support',409);
    await env.DB.prepare('INSERT OR IGNORE INTO beta_identities(chat_id,subscriber_id,created_at,created_beta) VALUES(?,?,?,?)').bind(row.chat_id,id,now,existing?0:1).run();
    const linked=await env.DB.prepare('SELECT subscriber_id FROM beta_identities WHERE chat_id=?').bind(row.chat_id).first<{subscriber_id:string}>();
    if(linked?.subscriber_id!==id)return fail('Telegram account conflict; contact support',409);
    if(!existing){for(const text of interests)await env.DB.prepare('INSERT OR IGNORE INTO subscriber_interests(id,subscriber_id,text,normalized_text,created_at,updated_at) SELECT ?,?,?,?,?,? WHERE (SELECT count(*) FROM subscriber_interests WHERE subscriber_id=?)<3').bind(uuid(),id,text,normalizeInterest(text),now,now,id).run();}
    const secret=randomSecret(),expires=new Date(Date.now()+SESSION_SECONDS*1000).toISOString();
    await env.DB.prepare('INSERT INTO beta_sessions(session_hash,subscriber_id,created_at,expires_at) VALUES(?,?,?,?)').bind(await hash(secret),id,now,expires).run();
    await env.DB.prepare("UPDATE beta_challenges SET interests_json='[]',display_code='' WHERE challenge_hash=?").bind(row.challenge_hash).run();
    const response=withCookie(json({status:'complete'}),cookie(request,sessionCookie,secret,SESSION_SECONDS));
    response.headers.append('Set-Cookie',cookie(request,browserCookie,'',0));return response;
  }
  const id=await sessionOwner(request,env);if(!id)return fail('not authenticated',401);
  if(body.action==='logout'){
    await env.DB.prepare('DELETE FROM beta_sessions WHERE session_hash=? AND subscriber_id=?').bind(await hash(getCookie(request,sessionCookie)),id).run();
    return withCookie(json({ok:true}),cookie(request,sessionCookie,'',0));
  }
  if(body.action==='pause' || body.action==='resume' || body.action==='cancel'){
    const account=await env.DB.prepare('SELECT s.status,s.expires_at,s.trial_ends_at,b.created_beta,b.paused_from,b.notifications_enabled_at FROM subscribers s JOIN beta_identities b ON b.subscriber_id=s.id WHERE s.id=?').bind(id).first<{status:string;expires_at:string|null;trial_ends_at:string|null;created_beta:number;paused_from:string|null;notifications_enabled_at:string|null}>();
    if(!account || account.status==='cancelled')return fail('subscription cannot be changed',409);
    let status='cancelled';
    if(body.action!=='resume')await env.DB.prepare('UPDATE beta_identities SET notifications_enabled_at=NULL WHERE subscriber_id=?').bind(id).run();
    if(body.action==='pause'){
      if(!['active','trial'].includes(account.status))return fail('subscription cannot be paused',409);
      await env.DB.prepare('UPDATE beta_identities SET paused_from=? WHERE subscriber_id=?').bind(account.status,id).run();
      status='paused';
    }else if(body.action==='resume'){
      if(account.created_beta && account.status==='active' && !account.notifications_enabled_at){if(account.expires_at && account.expires_at<=nowISO())return fail('subscription expired',409);await env.DB.prepare('UPDATE beta_identities SET notifications_enabled_at=? WHERE subscriber_id=?').bind(nowISO(),id).run();return json({ok:true,status:'active'});}
      if(account.status!=='paused' || (!account.created_beta && !account.paused_from))return fail('subscription cannot be resumed',409);
      status=account.paused_from || 'active';
      if((status==='active' && account.expires_at && account.expires_at<=nowISO()) || (status==='trial' && account.trial_ends_at && account.trial_ends_at<=nowISO()))return fail('subscription expired',409);
    }
    const result=await env.DB.prepare('UPDATE subscribers SET status=? WHERE id=? AND status=?').bind(status,id,account.status).run();
    if(result.meta.changes && body.action==='resume')await env.DB.prepare('UPDATE beta_identities SET notifications_enabled_at=? WHERE subscriber_id=?').bind(nowISO(),id).run();
    return result.meta.changes?json({ok:true,status}):fail('subscription cannot be changed',409);
  }
  return fail('invalid action');
};
