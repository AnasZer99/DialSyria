// A single wall-clock and request budget can be shared across all interests.
// The response body is bounded as well as the initial fetch; no news data is mocked here.
export function isLiveBudgetError(error:unknown):boolean {
  return /live discovery (?:time|request) budget exhausted|live discovery request timed out/.test(String(error));
}
type Shared={deadline:number;requests:number;maxRequests:number};
export interface LiveBudget {
  fetcher:typeof fetch;
  remaining():number;
  exhausted():boolean;
  requests():number;
  fork(milliseconds:number):LiveBudget;
}
export function createLiveBudget(fetcher:typeof fetch=fetch,totalMs=18000,maxRequests=24,perRequestMs=2500):LiveBudget {
  const shared:Shared={deadline:Date.now()+Math.max(0,totalMs),requests:0,maxRequests};
  function make(deadline:number):LiveBudget {
    const remaining=()=>Math.max(0,Math.min(deadline,shared.deadline)-Date.now());
    const exhausted=()=>remaining()<=0 || shared.requests>=shared.maxRequests;
    const bounded:typeof fetch=async(input,init)=>{
      if(remaining()<=0)throw new Error('live discovery time budget exhausted');
      if(shared.requests>=shared.maxRequests)throw new Error('live discovery request budget exhausted');
      shared.requests++;
      const controller=new AbortController();
      const original=init?.signal;
      const requestEnd=Math.min(Date.now()+perRequestMs,deadline,shared.deadline);
      const signal=original?AbortSignal.any([original,controller.signal]):controller.signal;
      const run=async<T>(operation:()=>Promise<T>):Promise<T>=>{
        const available=requestEnd-Date.now();
        if(available<=0){controller.abort();throw new Error(remaining()<=0?'live discovery time budget exhausted':'live discovery request timed out');}
        let timer:ReturnType<typeof setTimeout>|undefined;
        try{return await Promise.race([operation(),new Promise<T>((_,reject)=>{timer=setTimeout(()=>{controller.abort();reject(new Error(remaining()<=0?'live discovery time budget exhausted':'live discovery request timed out'));},available);})]);}
        finally{if(timer!==undefined)clearTimeout(timer);}
      };
      const response=await run(()=>fetcher(input,{...init,signal}));
      return new Proxy(response,{get(target,key){
        const value=Reflect.get(target,key,target);
        if(typeof value!=='function')return value;
        if(['text','json','arrayBuffer','blob','formData'].includes(String(key)))return (...args:unknown[])=>run(async()=>Reflect.apply(value,target,args));
        return value.bind(target);
      }});
    };
    (bounded as typeof fetch & {remaining?:()=>number}).remaining=remaining;
    return {fetcher:bounded,remaining,exhausted,requests:()=>shared.requests,fork:ms=>make(Math.min(deadline,Date.now()+Math.max(0,ms)))};
  }
  return make(shared.deadline);
}
