import { checkAdmin, checkCronSecret, fail, isPrivateChatId, json, readJson, stagingAllowlistsValid, type Env, type Handler } from './_lib';
import { betaDeliveryAllowed, createMockTelegramTransport, createTelegramTransport, runPreparation, type BetaDeliveryPolicy, type DeliveryTransport } from './_notify';
import type { Database } from './_discovery';
import { runLiveInterest } from './_live_interest';
import { createLiveBudget } from './_live_budget';

// Protected workflow: prepares personalized previews and, only behind the explicit
// server-side TELEGRAM_DELIVERY_ENABLED flag plus the TELEGRAM_TEST_CHAT_IDS allowlist,
// delivers them through the real Bot API transport. `simulate` renders through the
// in-memory mock transport without persisting any delivery status and never contacts
// Telegram.
export const onRequestPost: Handler<Env> = async ({ request, env }) => {
  if (!env.DB) return fail('database not bound', 500);
  if (!checkCronSecret(request, env) && !(await checkAdmin(request, env))) return fail('unauthorized', 401);
  const body = await readJson<{ subscriber_id?: unknown; simulate?: unknown; mode?: unknown; beta_manual?:unknown; refresh_sources?:unknown } | null>(request);
  const subscriberId = body && typeof body.subscriber_id === 'string' && body.subscriber_id ? body.subscriber_id : undefined;
  const simulate = !!(body && body.simulate === true);
  const mode = body && body.mode === 'deliver' ? 'deliver' : 'prepare';
  const deliveryEnabled = env.TELEGRAM_DELIVERY_ENABLED === '1';
  const testRecipients = new Set((env.TELEGRAM_TEST_CHAT_IDS || '').split(/[\s,]+/).map((s) => s.trim()).filter(Boolean));
  if(!stagingAllowlistsValid(env))return fail('invalid staging allowlists',503);
  if(env.STAGING_PILOT_MODE==='1' && simulate)return fail('simulation is disabled on staging',403);
  if(env.STAGING_PILOT_MODE==='1' && body?.beta_manual!==true && mode==='deliver')return fail('staging delivery requires manual beta request',403);

  if(body?.beta_manual===true){
    // A cron-secret request is not a manual operator action. One admin-authorized
    // subscriber per request; no beta broadcast or scheduled delivery path.
    if(!await checkAdmin(request,env))return fail('manual beta delivery requires admin authentication',403);
    if(!subscriberId)return fail('subscriber_id required',400);
    const identity=await env.DB.prepare('SELECT chat_id FROM beta_identities WHERE subscriber_id=? AND created_beta=1').bind(subscriberId).first<{chat_id:string}>();
    if(!identity)return fail('beta account not found',404);
    const policy:BetaDeliveryPolicy={invited:env.BETA_ALLOWED_TELEGRAM_IDS || '',recipients:env.TELEGRAM_TEST_CHAT_IDS || '',freshnessHours:Number(env.BETA_FRESHNESS_HOURS || 72),expectedChat:identity.chat_id};
    const db=env.DB as unknown as Database;
    if(!await betaDeliveryAllowed(db,subscriberId,policy))return fail('beta recipient is not eligible or allowlisted',403);
    if(!simulate && mode==='deliver' && (!deliveryEnabled || !env.TELEGRAM_BOT_TOKEN))return fail('real delivery is disabled',403);
    const pilotKey=`staging-pilot-send:${subscriberId}`;
    if(env.STAGING_PILOT_MODE==='1' && !simulate && mode==='deliver'){
      const prior=await env.DB.prepare('SELECT key FROM rate_limits WHERE key=?').bind(pilotKey).first();
      if(prior)return json({mode,simulated:false,deliveryEnabled,sent:0,failed:0,prepared:0,pilotAttemptUsed:true});
    }
    const refreshErrors:string[]=[];
    const refreshStatus:{interest:string;incomplete:boolean;verified:number;skipped?:boolean;monitoredSources?:number;monitorSkipped?:number;searchStarted?:boolean;sourceSearchStarted?:boolean;fallbackStarted?:boolean;found?:number;rejected?:number;unprocessed?:number;requests?:number;reason?:string}[]=[];
    if(body.refresh_sources===true){
      const budget=createLiveBudget(fetch,18000,24);
      const interests=await env.DB.prepare('SELECT text FROM subscriber_interests WHERE subscriber_id=? ORDER BY created_at LIMIT 3').bind(subscriberId).all<{text:string}>();
      for(const [index,item] of interests.results.entries()){
        if(budget.exhausted()){refreshStatus.push({interest:item.text,incomplete:true,verified:0,skipped:true,reason:'shared refresh budget exhausted'});continue;}
        if(!await betaDeliveryAllowed(db,subscriberId,policy))return fail('beta recipient is no longer eligible',403);
        const slice=budget.fork(Math.floor(budget.remaining()/(interests.results.length-index)));
        try{const result=await runLiveInterest(db,item.text,fetch,false,slice,1);const d=result.diagnostics;refreshStatus.push({interest:item.text,incomplete:d.incomplete,verified:d.directlyVerified,monitoredSources:d.monitoredSources,monitorSkipped:d.stages.monitorSkipped,searchStarted:d.stages.searchStarted,sourceSearchStarted:d.stages.sourceSearchStarted,fallbackStarted:d.stages.fallbackStarted,found:d.found,rejected:d.rejected,unprocessed:d.unprocessed,requests:d.requests});refreshErrors.push(...d.errors,...d.warnings);}catch(e){refreshStatus.push({interest:item.text,incomplete:true,verified:0,reason:'source refresh failed'});refreshErrors.push(`source refresh failed: ${e instanceof Error?e.message:'unknown error'}`);}
      }
    }
    const mock=createMockTelegramTransport();
    const real=createTelegramTransport(env,identity.chat_id);
    const guarded:DeliveryTransport={send:async text=>{
      if(!await betaDeliveryAllowed(db,subscriberId,policy))return {ok:false,error:'recipient no longer eligible'};
      if(env.STAGING_PILOT_MODE==='1'){
        if(text.length>3500)return {ok:false,error:'pilot message exceeds one Telegram message'};
        // One attempt per account, retained even on timeout: the Bot API result
        // may be ambiguous, and automatically retrying could duplicate a send.
        const claim=await env.DB.prepare('INSERT OR IGNORE INTO rate_limits(key,window,count) VALUES(?,?,1)').bind(pilotKey,'staging-pilot').run();
        if(!claim.meta.changes)return {ok:false,error:'pilot attempt already used'};
      }
      return real.send(text);
    }};
    const result=await runPreparation(db,{subscriberId,beta:policy,transport:simulate?mock:mode==='deliver'?guarded:undefined,persist:simulate?false:undefined,limit:env.STAGING_PILOT_MODE==='1'?1:undefined});
    return json({...result,mode,simulated:simulate,deliveryEnabled,refreshStatus,refreshErrors,refreshIncomplete:refreshStatus.some(x=>x.incomplete)});
  }

  let transportFor: ((subscriberId: string) => DeliveryTransport | undefined) | undefined;
  if (simulate) {
    const mock = createMockTelegramTransport();
    transportFor = () => mock;
  } else if (mode === 'deliver' && deliveryEnabled) {
    // Real delivery is restricted to explicitly allowlisted chat IDs only.
    const chats = await env.DB.prepare('SELECT id, telegram_chat_id FROM subscribers WHERE telegram_chat_id IS NOT NULL').bind().all<{ id: string; telegram_chat_id: string }>();
    const bySubscriber = new Map(
      chats.results
        .filter((row) => isPrivateChatId(row.telegram_chat_id) && testRecipients.has(row.telegram_chat_id))
        .map((row) => [row.id, createTelegramTransport(env, row.telegram_chat_id)])
    );
    transportFor = (id) => bySubscriber.get(id);
  }

  const result = await runPreparation(env.DB as unknown as Database, {
    subscriberId,
    transportFor,
    persist: simulate ? false : undefined,
  });
  return json({ ...result, mode, deliveryEnabled, testRecipientCount: testRecipients.size, simulated: simulate });
};
