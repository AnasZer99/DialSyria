import { type Env, stagingAllowlistsValid } from './_lib';
import { normalize, type Database } from './_discovery';
import { attachCandidateSources } from './_source_catalog';
import { discoverDirectSources, monitorDirectSources } from './_direct';
import { createLiveBudget } from './_live_budget';
import type { InterestWriteGuard } from './_interest_guard';

// One shared interest per invocation; no notification or Telegram Bot API path.
// Leave five minutes of slack for a half-hour trigger's execution and jitter.
// Provider Retry-After and cooldowns below always override this minimum.
const RETRY_MS=25*60_000, NO_SOURCE_MS=6*3600_000, DISCOVERY_MS=24*3600_000;
type Job={interest_key:string;status:string;source_count:number;last_discovery_at:string|null};
type InterestOwner={id:string;text:string;updated_at:string};

function eligibility(env:Env,now:string) {
  const invited=[...new Set((env.BETA_ALLOWED_TELEGRAM_IDS || '').split(',').map(x=>x.trim()).filter(x=>/^[1-9]\d*$/.test(x)))];
  const slots=invited.length ? invited.map(()=>'?').join(',') : 'NULL';
  return {sql:`((s.status='active' AND (s.expires_at IS NULL OR s.expires_at>?)) OR (s.status='trial' AND (s.trial_ends_at IS NULL OR s.trial_ends_at>?)))
    AND ((b.subscriber_id IS NULL AND substr(s.id,1,5)<>'beta_') OR
      (b.subscriber_id IS NOT NULL AND b.notifications_enabled_at IS NOT NULL AND b.chat_id=s.telegram_chat_id
       AND b.chat_id IN (${slots}) AND (SELECT COUNT(*) FROM subscribers owner WHERE owner.telegram_chat_id=b.chat_id)=1))`,
    args:[now,now,...invited]};
}

function failureCode(errors:string[],exhausted:boolean):string {
  if(errors.some(e=>/429|cooldown/i.test(e)))return 'rate_limited';
  if(errors.some(e=>/D1 query budget exhausted/i.test(e)))return 'd1_budget';
  if(exhausted || errors.some(e=>/timed out|budget exhausted/i.test(e)))return 'deadline_or_timeout';
  if(errors.some(e=>/verification pending/i.test(e)))return 'verification_pending';
  return 'source_or_search_unavailable';
}

export async function runInterestSweep(db:Database,env:Env,fetcher:typeof fetch=fetch) {
  if(!stagingAllowlistsValid(env))throw new Error('invalid staging allowlists');
  // Workers Free allows 50 D1 queries per invocation. Stop starting source
  // work at 36, leaving room for staging middleware, fenced writes and lease finalization.
  const underlying=db;let dbQueries=0;
  db={prepare(sql){const statement=underlying.prepare(sql);return {bind(...args:unknown[]){const q=statement.bind(...args);return {
    first<T>(){dbQueries++;return q.first<T>();},all<T>(){dbQueries++;return q.all<T>();},run(){dbQueries++;return q.run();}
  };}};}};
  const started=Date.now(), timings:Record<string,number>={}, now=new Date().toISOString(),filter=eligibility(env,now);
  // New/edited interests and pre-migration interests need no request-time network.
  const fresh=await db.prepare(`SELECT i.normalized_text AS interest_key FROM subscriber_interests i
    JOIN subscribers s ON s.id=i.subscriber_id LEFT JOIN beta_identities b ON b.subscriber_id=s.id
    LEFT JOIN interest_monitor_jobs j ON j.interest_key=i.normalized_text
    WHERE j.interest_key IS NULL AND ${filter.sql} ORDER BY i.created_at,i.id LIMIT 1`).bind(...filter.args).first<{interest_key:string}>();
  if(fresh)await db.prepare("INSERT OR IGNORE INTO interest_monitor_jobs(interest_key,interest_text,status,created_at,updated_at) VALUES(?,?,'pending',?,?)")
    .bind(fresh.interest_key,fresh.interest_key,now,now).run();

  const token=crypto.randomUUID(),leaseMs=Date.now()+60_000,lease=new Date(leaseMs).toISOString();
  const job=await db.prepare(`UPDATE interest_monitor_jobs SET claim_token=?,lease_until=?,updated_at=?,interest_text=interest_key
    WHERE interest_key=(SELECT j.interest_key FROM interest_monitor_jobs j WHERE (j.next_attempt_at IS NULL OR j.next_attempt_at<=?)
      AND (j.lease_until IS NULL OR j.lease_until<=?) AND EXISTS(SELECT 1 FROM subscriber_interests i JOIN subscribers s ON s.id=i.subscriber_id
      LEFT JOIN beta_identities b ON b.subscriber_id=s.id WHERE i.normalized_text=j.interest_key AND ${filter.sql})
      ORDER BY COALESCE(j.next_attempt_at,j.created_at),j.created_at,j.interest_key LIMIT 1)
    AND (lease_until IS NULL OR lease_until<=?) RETURNING interest_key,status,source_count,last_discovery_at`)
    .bind(token,lease,now,now,now,...filter.args,now).first<Job>();
  timings.claim_ms=Date.now()-started;
  if(!job)return {mode:'sweep',checked:0};

  const ownerFilter=eligibility(env,new Date().toISOString());
  const owner=await db.prepare(`SELECT i.id,i.text,i.updated_at FROM subscriber_interests i JOIN subscribers s ON s.id=i.subscriber_id
    LEFT JOIN beta_identities b ON b.subscriber_id=s.id WHERE i.normalized_text=? AND ${ownerFilter.sql} ORDER BY i.created_at,i.id LIMIT 1`)
    .bind(job.interest_key,...ownerFilter.args).first<InterestOwner>();
  let stopReason:'eligibility_changed'|'lease_lost'|null=owner?null:'eligibility_changed';
  const guard:InterestWriteGuard={
    sql:`EXISTS (SELECT 1 FROM interest_monitor_jobs j JOIN subscriber_interests i ON i.id=? JOIN subscribers s ON s.id=i.subscriber_id
      LEFT JOIN beta_identities b ON b.subscriber_id=s.id WHERE j.interest_key=? AND j.claim_token=? AND j.lease_until>?
      AND i.normalized_text=j.interest_key AND i.text=? AND i.updated_at=? AND ${ownerFilter.sql})`,
    args(){const time=new Date().toISOString(),current=eligibility(env,time);return [owner?.id || '',job!.interest_key,token,time,owner?.text || '',owner?.updated_at || '',...current.args];}
  };
  const authorize=async():Promise<boolean>=>{
    if(stopReason)return false;
    if(Date.now()>=leaseMs){stopReason='lease_lost';return false;}
    const ok=await db.prepare(`SELECT 1 AS ok WHERE ${guard.sql}`).bind(...guard.args()).first<{ok:number}>();
    if(Date.now()>=leaseMs){stopReason='lease_lost';return false;}
    if(ok)return true;
    const current=await db.prepare('SELECT claim_token,lease_until FROM interest_monitor_jobs WHERE interest_key=?').bind(job.interest_key).first<{claim_token:string|null;lease_until:string|null}>();
    stopReason=current?.claim_token!==token || !current.lease_until || current.lease_until<=new Date().toISOString()?'lease_lost':'eligibility_changed';
    return false;
  };
  const guardedFetch:typeof fetch=async(input,init)=>{
    if(!await authorize())throw new Error('live discovery time budget exhausted');
    if(init?.signal?.aborted)throw new Error('live discovery request timed out');
    return fetcher(input,init);
  };
  const budget=createLiveBudget(guardedFetch,15_000,12,2500),errors:string[]=[];
  const shouldStop=()=>!!stopReason || budget.exhausted() || dbQueries>=36;
  let status='temporary_failure',sourceCount=job.source_count,discoveryAt=job.last_discovery_at,discoveryStarted=false,monitored=0,monitorSucceeded=false;
  let entriesRead=0,verified=0,rejected=0,pendingCandidates=0,pendingPages=0,failedCandidates=0,phase='link_sources',errorPhase:string|null=null;
  try {
    if(!owner || !await authorize())throw new Error('interest authorization changed');
    await attachCandidateSources(db,owner.text,{authorize,guard});
    timings.link_ms=Date.now()-started-timings.claim_ms;
    if(!await authorize())throw new Error('interest authorization changed');
    phase='monitor';const monitorStart=Date.now();
    const monitor=await monitorDirectSources(db,owner.text,{fetcher:budget.fetcher,shouldStop,authorize,guard,durable:true,lookbackHours:Number(env.BETA_FRESHNESS_HOURS || 72)});
    timings.monitor_ms=Date.now()-monitorStart;
    monitored=monitor.observations.length;errors.push(...monitor.errors);
    // A bounded but partial pass is still useful work from a linked source.
    monitorSucceeded=monitor.observations.some(o=>o.accessible);
    if(monitor.incomplete)errorPhase='monitor';
    for(const observation of monitor.observations){entriesRead+=observation.entriesRead;verified+=observation.verified;rejected+=observation.rejected;pendingCandidates+=observation.unprocessed;pendingPages+=Number(observation.paginationPending);failedCandidates+=observation.failedCandidates;}
    if(dbQueries>=36 && (monitor.incomplete || monitored<monitor.sources.length))errors.push('D1 query budget exhausted');
    if(monitor.incomplete && !monitor.errors.length)errors.push(pendingCandidates?'verification pending':'monitor incomplete');
    const interval=job.status==='no_source'?NO_SOURCE_MS:DISCOVERY_MS;
    const discoveryDue=!job.last_discovery_at || Date.now()-Date.parse(job.last_discovery_at)>=interval;
    // Known sources are the MVP's primary path. Open search remains available
    // for uncovered interests, and can separately be enabled for expansion.
    const searchDue=discoveryDue && (!monitor.observations.some(o=>o.accessible) || env.DISCOVERY_EXPAND_LINKED_SOURCES==='1');
    if(searchDue && !shouldStop() && await authorize()) {
      discoveryStarted=true;
      phase='discovery';const discoveryStart=Date.now();
      const discovery=await discoverDirectSources(db,owner.text,{fetcher:budget.fetcher,shouldStop,maxQueries:1,authorize,guard});
      timings.discovery_ms=Date.now()-discoveryStart;
      errors.push(...discovery.errors);
      if(discovery.incomplete && !errorPhase)errorPhase='discovery';
      if(discovery.incomplete && !discovery.errors.length)errors.push('discovery incomplete');
      if(!discovery.incomplete)discoveryAt=new Date().toISOString();
    } else if(searchDue && budget.exhausted()){errors.push('discovery budget exhausted');errorPhase ||= 'discovery';}
    phase='finalize';if(!await authorize())throw new Error('interest authorization changed');
    const count=await db.prepare('SELECT COUNT(*) AS n FROM direct_source_interests WHERE interest_key=?').bind(normalize(owner.text)).first<{n:number}>();
    sourceCount=count?.n || 0;
    status=errors.length || budget.exhausted()?(monitorSucceeded && sourceCount?'source_linked':'temporary_failure'):sourceCount?'source_linked':'no_source';
  } catch(e) { errorPhase ||= phase;errors.push(e instanceof Error ? e.message : 'operation failed'); }
  if(!stopReason)await authorize();
  const finalReason=(): 'eligibility_changed'|'lease_lost'|null => stopReason;
  if(finalReason()==='lease_lost')return {mode:'sweep',checked:0,status:'claim_lost',incomplete:true,errorCode:'lease_lost',requests:budget.requests()};
  if(finalReason()==='eligibility_changed'){status='pending';discoveryAt=job.last_discovery_at;sourceCount=job.source_count;}
  const completed=new Date().toISOString(),errorCode=finalReason()==='eligibility_changed'?'eligibility_changed':errors.length || budget.exhausted()?failureCode(errors,budget.exhausted()):null;
  let delay=status==='no_source'?NO_SOURCE_MS:RETRY_MS;
  for(const message of errors){const seconds=Number(message.match(/Retry-After (\d+)s/i)?.[1] || 0);if(Number.isFinite(seconds))delay=Math.max(delay,seconds*1000);const until=message.match(/cooldown until ([0-9T:.Z-]+)/i)?.[1];if(until && Number.isFinite(Date.parse(until)))delay=Math.max(delay,Date.parse(until)-Date.now());}
  const next=status==='pending'?null:new Date(Math.min(8640000000000000,Date.now()+delay)).toISOString();
  const committed=await db.prepare(`UPDATE interest_monitor_jobs SET status=?,source_count=?,last_attempt_at=?,last_discovery_at=?,next_attempt_at=?,error_code=?,claim_token=NULL,lease_until=NULL,updated_at=? WHERE interest_key=? AND claim_token=? AND lease_until>?${status==='pending'?'':` AND ${guard.sql}`}`)
    .bind(status,sourceCount,completed,discoveryAt,next,errorCode,completed,job.interest_key,token,new Date().toISOString(),...(status==='pending'?[]:guard.args())).run();
  if(!committed.meta.changes){
    // Consent can change between the last check and the conditional commit.
    await authorize();
    if(finalReason()==='eligibility_changed'){
      const released=await db.prepare("UPDATE interest_monitor_jobs SET status='pending',last_attempt_at=?,next_attempt_at=NULL,error_code='eligibility_changed',claim_token=NULL,lease_until=NULL,updated_at=? WHERE interest_key=? AND claim_token=? AND lease_until>?")
        .bind(completed,completed,job.interest_key,token,new Date().toISOString()).run();
      if(released.meta.changes)return {mode:'sweep',checked:1,status:'pending',incomplete:true,errorCode:'eligibility_changed',requests:budget.requests()};
    }
    return {mode:'sweep',checked:0,status:'claim_lost',incomplete:true,errorCode:'lease_lost',requests:budget.requests()};
  }
  const incomplete=!!errorCode || status==='temporary_failure'||status==='pending';
  const outcome=incomplete && monitorSucceeded && status==='source_linked'?'partial_success':incomplete?'temporary_failure':status==='no_source'?'no_source':'completed';
  const diagnostics={outcome,phase:errorPhase || phase,errorCode,monitored,entriesRead,verified,rejected,pendingCandidates,pendingPages,failedCandidates,dbQueries,requests:budget.requests(),timings:{...timings,total_ms:Date.now()-started}};
  console.log('interest_sweep',JSON.stringify(diagnostics));
  return {mode:'sweep',checked:1,status,sourceCount,monitored,discoveryStarted,requests:budget.requests(),incomplete,errorCode,outcome,diagnostics};
}
