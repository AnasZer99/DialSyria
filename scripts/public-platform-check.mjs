const checks=[['telegram','https://t.me/s/SyMOHEASR/13839'],['telegram','https://t.me/s/SyriaDefence/64615'],['facebook','https://www.facebook.com/SyMOHEASR']];
for(const [type,url] of checks) {
  try {const r=await fetch(url,{redirect:'manual',signal:AbortSignal.timeout(10000)}); const body=(await r.text()).slice(0,300000); console.log(JSON.stringify({type,url,status:r.status,location:r.headers.get('location'),title:body.match(/<title[^>]*>([^<]*)<\/title>/i)?.[1]||null,publicMessage:type==='telegram' && body.includes('tgme_widget_message_text'),loginMarker:/login|log in|تسجيل الدخول/i.test(body)}));}
  catch(e){console.log(JSON.stringify({type,url,error:String(e),cause:String(e.cause||'')}));}
}
