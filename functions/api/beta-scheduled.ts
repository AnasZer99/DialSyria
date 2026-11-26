import {checkCronSecret, fail, json, stagingAllowlistsValid, type Env, type Handler} from './_lib';
import {betaDeliveryAllowed, createTelegramTransport, deliverPending, prepareNotifications, type BetaDeliveryPolicy} from './_notify';
import type {Database} from './_discovery';

// Separate from the legacy digest and manual beta pilot. Both flags default off.
export const onRequestPost:Handler<Env> = async ({request,env}) => {
  if(!env.DB)return fail('database not bound',500);
  if(!checkCronSecret(request,env))return fail('unauthorized',401);
  if(!stagingAllowlistsValid(env))return fail('invalid staging allowlists',503);
  const db=env.DB as unknown as Database;
  const invited=env.BETA_ALLOWED_TELEGRAM_IDS || '';
  const recipients=env.TELEGRAM_TEST_CHAT_IDS || '';
  const deliver=env.TELEGRAM_DELIVERY_ENABLED==='1' && env.BETA_SCHEDULED_DELIVERY_ENABLED==='1' && !!env.TELEGRAM_BOT_TOKEN;
  const users=await db.prepare('SELECT subscriber_id,chat_id FROM beta_identities WHERE created_beta=1 AND notifications_enabled_at IS NOT NULL ORDER BY subscriber_id LIMIT 20').bind().all<{subscriber_id:string;chat_id:string}>();
  let prepared=0,sent=0,failed=0,eligible=0;
  for(const user of users.results){
    const policy:BetaDeliveryPolicy={invited,recipients:deliver?recipients:invited,expectedChat:user.chat_id,freshnessHours:Number(env.BETA_FRESHNESS_HOURS || 72)};
    if(!await betaDeliveryAllowed(db,user.subscriber_id,policy))continue;
    eligible++;
    const result=await prepareNotifications(db,user.subscriber_id,{beta:policy,limit:1});prepared+=result.items.length;
    if(!deliver)continue;
    const actual=createTelegramTransport(env,user.chat_id);
    const transport={send:async(text:string)=>text.length>3500?{ok:false,error:'message too long'}:actual.send(text)};
    // Ambiguous failures and expired claims remain untouched for operator review.
    const delivery=await deliverPending(db,user.subscriber_id,transport,{beta:policy,limit:1,includeFailed:false,safeNoRetry:true});
    sent+=delivery.sent;failed+=delivery.failed;
  }
  const summary={mode:'beta_scheduled',eligible,prepared,sent,failed,deliveryEnabled:deliver};
  console.log('beta_scheduled',JSON.stringify(summary));
  return json(summary);
};
