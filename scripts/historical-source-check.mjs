// Historical reference validation only: known URLs below are NOT inserted into D1
// and are NOT treated as newly discovered notifications.
import {build} from 'esbuild';
const bundle=async path=>{const b=await build({entryPoints:[path],bundle:true,platform:'neutral',format:'esm',write:false});return import('data:text/javascript;base64,'+Buffer.from(b.outputFiles[0].contents).toString('base64'));};
const {parseTelegram}=await bundle('functions/api/_direct.ts');
const {evaluateDirect}=await bundle('functions/api/_discovery.ts');
const {allowedByRobots,inspectPublisher}=await bundle('functions/api/_publisher.ts');
const references=[
 {interest:'قرارات جامعة إدلب المتعلقة بالامتحانات والتسجيل',url:'https://t.me/IdlebUniversity/11735',channel:'https://t.me/s/IdlebUniversity',name:'جامعة إدلب'},
 {interest:'قرارات وزارة التعليم العالي السورية المتعلقة بالقبول الجامعي',url:'https://t.me/SyMOHEASR/13905',channel:'https://t.me/s/SyMOHEASR',name:'وزارة التعليم العالي والبحث العلمي السورية'},
 {interest:'مشاريع الخدمات والبنية التحتية في إدلب',url:'https://sana.sy/governorates/edlib/2623191/',name:'سانا'},
];
for(const ref of references) {
 try {
  let title,content,date,verification;
  if(ref.channel) {
   const origin=new URL(ref.channel).origin;
   const robots=await fetch(origin+'/robots.txt',{redirect:'manual',signal:AbortSignal.timeout(8000),headers:{'user-agent':'DialSyria-Discovery/1.0'}});
   const detailUrl=ref.channel+'/'+new URL(ref.url).pathname.split('/').filter(Boolean).pop();
   if(robots.status!==404 && (!robots.ok || !allowedByRobots(await robots.text(),new URL(detailUrl).pathname))) throw Error('robots denied or unavailable');
   const response=await fetch(detailUrl,{redirect:'manual',signal:AbortSignal.timeout(8000),headers:{'user-agent':'DialSyria-Discovery/1.0'}});
   if(!response.ok)throw Error('HTTP '+response.status);
   const html=await response.text();
   const post=parseTelegram(html,ref.channel).find(p=>p.url.toLowerCase()===ref.url.toLowerCase());
   if(!post)throw Error('reference post not present on public channel page');
   title=post.text.slice(0,180);content=post.text;date=post.publishedAt;verification='public channel permalink; identity self-declared';
  } else {
   const page=await inspectPublisher(ref.url,ref.url);
   if(page.verificationStatus!=='publisher_metadata' || !page.publisherTitle || !page.publisherText)throw Error('publisher metadata or content unavailable');
   title=page.publisherTitle;content=page.publisherText;date=page.publisherPublishedAt;verification='publisher metadata and article content';
  }
  const decision=evaluateDirect(ref.interest,{title,url:ref.url,source:ref.name,description:content,publishedAt:date,provider:'historical-reference'});
  const inLast30Days=!!date && Date.parse(date)<=Date.now()+86400000 && Date.now()-Date.parse(date)<=30*86400000;
  console.log(JSON.stringify({mode:'historical-reference-only',interest:ref.interest,url:ref.url,title,date,inLast30Days,verification,relevant:decision.accepted,reason:decision.reason}));
 }catch(error){console.log(JSON.stringify({mode:'historical-reference-only',interest:ref.interest,url:ref.url,error:String(error)}));}
}
