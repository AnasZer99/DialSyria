// Staging-only interest monitoring. This Worker has no HTTP handler or delivery path.
const endpoint = 'https://dialsyria-staging.pages.dev/api/direct';
const betaEndpoint = 'https://dialsyria-staging.pages.dev/api/beta-scheduled';
const schedule = '*/30 * * * *';

export default {
  scheduled(event, env, ctx) {
    if (event.cron !== schedule || env.STAGING_SCHEDULER_ENABLED !== '1') return;
    const secret = env.CRON_SECRET;
    if (typeof secret !== 'string' || !/^[A-Za-z0-9_-]{32,256}$/.test(secret)) {
      console.error('Staging interest sweep skipped: missing or invalid cron secret');
      return;
    }
    ctx.waitUntil((async () => {
      const deadline=Date.now()+22000;
      // Each Pages sweep permits 12 network requests and 15 seconds. Only begin
      // another when its full budget and two seconds for D1 completion remain.
      const maxSweeps=env.STAGING_BATCH_SWEEP_ENABLED==='1'?Math.floor(24/12):1;
      for(let index=0;index<maxSweeps;index++) {
      if(index>0 && deadline-Date.now()<17000)break;
      let signal;
      let response;
      try {
        signal = AbortSignal.timeout(Math.max(1,deadline-Date.now()));
        response = await fetch(endpoint, {
          method: 'POST',
          headers: { 'content-type': 'application/json', 'x-cron-secret': secret },
          body: JSON.stringify({ mode: 'sweep' }),
          redirect: 'manual',
          signal,
        });
      } catch {
        // Do not log exception names or messages: they can contain credentials.
        console.error(signal?.aborted ? 'Staging interest sweep failed: timeout' : 'Staging interest sweep failed: transport error');
        break;
      }
      if (!response.ok) {
        console.error(`Staging interest sweep failed: HTTP ${response.status}`);
        break;
      }
      try {
        const result = await response.json();
        if (!result || typeof result !== 'object' || !Number.isInteger(result.checked)) {
          console.error('Staging interest sweep failed: invalid response');
          break;
        }
        if (result?.incomplete === true) {console.error('Staging interest sweep incomplete; check staging diagnostics');break;}
        if(result.checked===0)break;
      } catch {
        console.error(signal.aborted ? 'Staging interest sweep failed: timeout' : 'Staging interest sweep failed: invalid response');
        break;
      }
      }
      if(env.STAGING_BETA_PREPARATION_ENABLED !== '1')return;
      try {
        const response=await fetch(betaEndpoint,{method:'POST',headers:{'content-type':'application/json','x-cron-secret':secret},body:'{}',redirect:'manual',signal:AbortSignal.timeout(22000)});
        if(!response.ok)console.error(`Staging beta preparation failed: HTTP ${response.status}`);
      } catch { console.error('Staging beta preparation failed: transport or timeout'); }
    })());
  },
};
