// Runs against npm run beta:onboarding. This is a local simulator test only.
import assert from 'node:assert/strict';
const base='http://127.0.0.1:8788', headers={'content-type':'application/json',origin:base};
const post=(path,body,cookie)=>fetch(base+path,{method:'POST',headers:{...headers,...(cookie?{cookie}:{})},body:JSON.stringify(body)});
const getCookie=(res,name)=>res.headers.getSetCookie().find(x=>x.startsWith(name+'='))?.split(';')[0];
const begin=await post('/api/beta',{action:'begin',interests:['امتحانات جامعة إدلب']});assert.equal(begin.status,200,'begin');
const challenge=await begin.json(),browser=getCookie(begin,'ds_beta_browser');assert.ok(browser);
const simulated=await post('/api/beta-simulator',{token:challenge.token,id:'10002'});assert.equal(simulated.status,200,'simulated Telegram confirmation');
const completed=await post('/api/beta',{action:'poll'},browser);assert.equal(completed.status,200,'complete');const session=getCookie(completed,'ds_beta_session');assert.ok(session);
const profile=await fetch(base+'/api/beta',{headers:{cookie:session}});assert.equal(profile.status,200);const account=await profile.json();assert.equal(account.telegramConnected,true);assert.ok(account.interests.length>=1);
const logout=await post('/api/beta',{action:'logout'},session);assert.equal(logout.status,200);
assert.equal((await fetch(base+'/api/beta',{headers:{cookie:session}})).status,401);
console.log('Local browser API workflow passed: simulated confirmation, session, interests and logout. No Telegram message sent.');
