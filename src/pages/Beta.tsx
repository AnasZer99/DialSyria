import {useEffect,useState} from 'react';
import type {PageProps} from '../App';
import type {Interest} from '../lib/api';

type Profile={status:string;expiresAt:string|null;telegramConnected:boolean;notificationsEnabled:boolean;lastNotification:{title:string;url:string;sent_at:string}|null;readyCount:number;interests:Interest[]};
type Challenge={bot:string;token?:string;code:string;expiresAt:string;staging?:boolean};
async function call<T>(url:string,method='GET',body?:unknown):Promise<T>{
  const res=await fetch(url,{method,headers:method==='GET'?{}:{'content-type':'application/json'},body:body===undefined?undefined:JSON.stringify(body),credentials:'same-origin'});
  const result=await res.json().catch(()=>null);if(!res.ok)throw new Error(result?.error || `HTTP ${res.status}`);if(!result || typeof result!=='object')throw new Error('invalid response');return result as T;
}
const betaAction=(action:string,extra:Record<string,unknown>={})=>call<{status?:string}>('/api/beta','POST',{action,...extra});
function monitoringStatus(item:Interest,ar:boolean):string{
  if(item.monitoring_status==='source_linked' && item.error_code)return ar?'هناك مصدر مرتبط، لكن تعذّر إكمال المتابعة مؤقتًا وسنحاول مجددًا.':'A source is linked, but monitoring was incomplete; we will retry.';
  const messages={
    pending: ar?'جارٍ تجهيز متابعة هذا الاهتمام.':'Preparing to monitor this interest.',
    source_linked: ar?'مصادر مرتبطة للمتابعة؛ قد لا تتوفر تحديثات مناسبة.':'Sources linked; matching updates may not be available.',
    no_source: ar?'لم نعثر بعد على مصدر مناسب لهذا الاهتمام.':'No suitable source found yet.',
    temporary_failure: ar?'تعذرت المتابعة مؤقتًا، وسنحاول مجددًا.':'Monitoring is temporarily unavailable; we will retry.',
  };
  return messages[item.monitoring_status || 'pending'];
}

export default function Beta({lang,nav}:PageProps){
  const ar=lang==='ar';
  const [profile,setProfile]=useState<Profile|null>(null),[loading,setLoading]=useState(true),[busy,setBusy]=useState(false);
  const [inputs,setInputs]=useState(['','','']),[challenge,setChallenge]=useState<Challenge|null>(null),[error,setError]=useState(''),[editing,setEditing]=useState<string|null>(null),[text,setText]=useState('');
  const [returning,setReturning]=useState(false);
  const refresh=async()=>{const result=await call<Profile>('/api/beta');if(!Array.isArray(result.interests))throw new Error('invalid profile');setProfile(result);};
  useEffect(()=>{refresh().catch(()=>setProfile(null)).finally(()=>setLoading(false));},[]);
  useEffect(()=>{
    if(!challenge)return;
    let active=true;
    const poll=async()=>{try{const r=await betaAction('poll');if(active && r.status==='complete'){setChallenge(null);await refresh();nav('/manage');}}catch(e){if(active && e instanceof Error && (e.message.includes('expired') || e.message.includes('needs at least'))){setChallenge(null);setError(e.message.includes('needs at least')?(ar?'لإنشاء حساب جديد، أدخل اهتمامًا واحدًا على الأقل.':'Enter an interest to create a new account.'):(ar?'انتهت صلاحية الرابط. ابدأ من جديد.':'The link expired. Please start again.'));}}};
    const timer=window.setInterval(poll,3000);void poll();return()=>{active=false;clearInterval(timer);};
  },[challenge]);
  const begin=async()=>{
    const interests=returning?[]:inputs.map(x=>x.trim()).filter(Boolean);
    if(!returning && (!interests.length || interests.some(x=>x.length<3 || x.length>300))){setError(ar?'أدخل من اهتمام إلى ثلاثة اهتمامات، كل منها من 3 إلى 300 حرف.':'Enter one to three interests of 3–300 characters.');return;}
    setBusy(true);setError('');try{setChallenge(await call<Challenge>('/api/beta','POST',{action:'begin',interests}));}catch{setError(ar?'تعذر بدء التسجيل. حاول لاحقًا.':'Could not start sign-in. Please retry.');}finally{setBusy(false);}
  };
  const changeStatus=async(action:string)=>{if(action==='cancel'&&!window.confirm(ar?'إلغاء الاشتراك وإيقاف التنبيهات؟':'Cancel the subscription and stop notifications?'))return;setBusy(true);setError('');try{await betaAction(action);await refresh();}catch{setError(ar?'تعذر تغيير حالة الاشتراك.':'Could not change subscription status.');}finally{setBusy(false);}};
  const edit=async(id?:string)=>{setBusy(true);setError('');try{await call('/api/interests',id?'PATCH':'POST',id?{id,text}:{text});setText('');setEditing(null);await refresh();}catch{setError(ar?'تعذر حفظ الاهتمام. تأكد من صيغته وعدم تكراره.':'Could not save the interest. Check its length and duplicates.');}finally{setBusy(false);}};
  const remove=async(id:string)=>{setBusy(true);try{await call('/api/interests?id='+encodeURIComponent(id),'DELETE');await refresh();}catch{setError(ar?'تعذر حذف الاهتمام.':'Could not delete the interest.');}finally{setBusy(false);}};
  if(loading)return <div className="form note" role="status">{ar?'جارٍ التحميل…':'Loading…'}</div>;
  return <div className="form" dir={ar?'rtl':'ltr'}>
    <div className="kicker">{ar?'تجربة مغلقة':'CLOSED BETA'}</div>
    <h1 className="hero-title">{profile?(ar?'إدارة تجربتك':'Manage your beta'):(ar?'ابدأ تجربتك مع ديل سيريا':'Try DialSyria')}</h1>
    <p className="hero-sub">{ar?'نتابع مصادر محلية محدودة ونختبر ملاءمة النتائج؛ قد لا نجد كل المستجدات.':'We monitor a limited set of local sources; coverage is incomplete.'}</p>
    {error && <div className="err" role="alert">{error}</div>}
    {!profile && !challenge && <>
      <p>{returning?(ar?'سجّل الدخول بحساب Telegram المرتبط سابقًا.':'Sign in using your linked Telegram account.'):(ar?'ما المواضيع التي تهمك؟ أضف حتى ثلاثة اهتمامات بكلماتك.':'Add up to three interests in your own words.')}</p>
      {!returning && inputs.map((value,i)=><label key={i} className="step" style={{display:'block'}}>{ar?`الاهتمام ${i+1}`:`Interest ${i+1}`} {i>0 && (ar?'(اختياري)':'(optional)')}<input className="field" value={value} maxLength={300} placeholder={i===0?(ar?'مثال: قرارات جامعة إدلب حول الامتحانات':'Example: Idlib University exams'):''} onChange={e=>setInputs(inputs.map((v,j)=>j===i?e.target.value:v))}/></label>)}
      <button className="cta" disabled={busy} onClick={begin}>{busy?(ar?'جارٍ التحضير…':'Preparing…'):(ar?'المتابعة عبر Telegram':'Continue with Telegram')}</button>
      <button className="sublink" onClick={()=>{setReturning(!returning);setError('');}}>{returning?(ar?'إنشاء حساب جديد':'Create an account'):(ar?'لدي حساب بالفعل':'I already have an account')}</button>
    </>}
    {!profile && challenge && <div className="okbox">
      <h2>{ar?'أكمل التأكيد في Telegram':'Confirm in Telegram'}</h2>
      <p>{ar?'افتح البوت واضغط Start. اختر الرمز المطابق لهذا الرقم فقط، ولا توافق على طلب لم تبدأه بنفسك:':'Open the bot and press Start. Choose only the matching code and never approve a request you did not start:'}</p>
      <strong className="ltr" style={{fontSize:28,letterSpacing:4}}>{challenge.code}</strong>
      <p><a className="cta" href={challenge.staging?`https://t.me/${challenge.bot}`:`https://t.me/${challenge.bot}?start=b_${challenge.token}`} target="_blank" rel="noopener noreferrer">{ar?'فتح Telegram':'Open Telegram'}</a></p>
      <p className="note" role="status">{ar?'بعد التأكيد عد إلى هذه الصفحة. ينتهي الرابط بعد 10 دقائق.':'Return here after approval. The link expires after 10 minutes.'}</p>
      {challenge.token && ['localhost','127.0.0.1'].includes(window.location.hostname) && <button className="chip" onClick={async()=>{try{await call('/api/beta-simulator','POST',{token:challenge.token});}catch{setError('المحاكي المحلي غير متاح.');}}}>{ar?'محاكاة تأكيد Telegram محليًا':'Simulate Telegram locally'}</button>}
      <button className="sublink" onClick={()=>setChallenge(null)}>{ar?'بدء طلب جديد':'Start again'}</button>
    </div>}
    {profile && <>
      <p><strong>Telegram:</strong> {profile.telegramConnected?(ar?'متصل':'Connected'):(ar?'غير متصل':'Not connected')}</p>
      <p><strong>{ar?'التنبيهات:':'Notifications:'}</strong> {profile.notificationsEnabled?(ar?'مفعّلة':'Opted in'):profile.status==='cancelled'?(ar?'ملغاة':'Cancelled'):(ar?'متوقفة':'Paused')}</p>
      {profile.lastNotification ? <p>{ar?'آخر تنبيه شخصي أُرسل:':'Last personalized notification:'} <a href={profile.lastNotification.url} target="_blank" rel="noopener noreferrer">{profile.lastNotification.title}</a> · {new Date(profile.lastNotification.sent_at).toLocaleString(ar?'ar-SY':'en-GB')}</p> : <p className="note">{ar?'لم يُرسل تنبيه شخصي بعد.':'No personalized notification has been sent yet.'}</p>}
      {profile.readyCount===0 && <p className="note">{ar?'لا توجد تنبيهات حديثة مؤكدة جاهزة حاليًا؛ قد تكون هناك مصادر لم تُفحص بعد.':'No verified fresh notifications are currently queued; some sources may not have been checked yet.'}</p>}
      <p className="note">{ar?'يتطلب إرسال التحديثات موافقتك وتفعيل خدمة التنبيهات، وهي متوقفة حاليًا أثناء التجربة.':'Updates require your consent and an active notification service, which is currently disabled during the pilot.'}</p>
      <div className="rule"/><h2>{ar?'اهتماماتك':'Your interests'}</h2>
      {profile.interests.length===0 && <p className="note">{ar?'لم تضف اهتمامات بعد.':'You have no interests yet.'}</p>}
      <ul>{profile.interests.map(item=><li key={item.id}>{editing===item.id?<><label>{ar?'تعديل الاهتمام':'Edit interest'}<input className="field" value={text} onChange={e=>setText(e.target.value)} maxLength={300}/></label><button className="chip" disabled={busy} onClick={()=>edit(item.id)}>{ar?'حفظ':'Save'}</button><button className="chip" onClick={()=>{setEditing(null);setText('');}}>{ar?'إلغاء':'Cancel'}</button></>:<>{item.text} <button className="chip" onClick={()=>{setEditing(item.id);setText(item.text);}}>{ar?'تعديل':'Edit'}</button> <button className="chip" disabled={busy} onClick={()=>remove(item.id)}>{ar?'حذف':'Delete'}</button><p className="note">{monitoringStatus(item,ar)}</p></>}</li>)}</ul>
      {!editing && profile.interests.length<3 && <><label className="step" style={{display:'block'}}>{ar?'إضافة اهتمام':'Add interest'}<input className="field" value={text} onChange={e=>setText(e.target.value)} maxLength={300}/></label><button className="chip" disabled={busy} onClick={()=>edit()}>{ar?'إضافة':'Add'}</button></>}
      <div className="rule"/>
      {profile.status!=='cancelled' && <><button className="chip" disabled={busy} onClick={()=>changeStatus(profile.notificationsEnabled?'pause':'resume')}>{profile.notificationsEnabled?(ar?'إيقاف التنبيهات مؤقتًا':'Pause notifications'):(ar?'الموافقة على التنبيهات':'Opt in to notifications')}</button> <button className="chip" disabled={busy} onClick={()=>changeStatus('cancel')}>{ar?'إلغاء الاشتراك':'Cancel subscription'}</button></>}
      <button className="sublink" onClick={async()=>{await betaAction('logout');setProfile(null);}}>{ar?'تسجيل الخروج':'Sign out'}</button>
    </>}
    <p className="note">{ar?'الخصوصية: نخزّن معرّف Telegram واهتماماتك وحالة اشتراكك. إلغاء الاشتراك يوقف التنبيهات ولا يحذف البيانات؛ اطلب حذف الحساب من إدارة الخدمة.':'Privacy: we store your Telegram identifier, interests and subscription status. Cancellation stops notifications but does not erase your data; request account deletion from the service operator.'}</p>
  </div>;
}
