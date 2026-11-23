import {test} from 'node:test';
import assert from 'node:assert/strict';
import {loadDirect,openDatabase} from '../scripts/discovery-runtime.mjs';
const direct=await loadDirect();
const interest='تراخيص البناء في إدلب';
const title='قرار تراخيص البناء في إدلب';

test('discovers a source from search, monitors it twice and stores one item',async()=>{
 const {db,sqlite}=await openDatabase(':memory:');
 const fetcher=async url=>{
   const u=String(url);
   if(u.includes('news.google.com/rss/search'))return new Response(`<rss><item><title>${title}</title><link>https://news.google.com/rss/articles/example</link><source url="https://example.org">example</source></item></rss>`);
   if(u.endsWith('/robots.txt'))return new Response('User-agent: *\nAllow: /');
   if(u.endsWith('/feed/'))return new Response(`<rss><item><title>${title}</title><link>https://example.org/a</link><description>${title}</description></item></rss>`);
   if(u==='https://example.org/a')return new Response(`<meta property="og:title" content="${title}">`,{headers:{'content-type':'text/html'}});
   throw Error('unexpected '+u);
 };
 try {const found=await direct.discoverDirectSources(db,interest,{fetcher});assert.equal(found.discovered.length,1);
   const first=await direct.monitorDirectSources(db,interest,{fetcher});const second=await direct.monitorDirectSources(db,interest,{fetcher});
   assert.equal(first.items.length,1);assert.equal(first.items[0].duplicate,false);assert.equal(second.items[0].duplicate,true);
   assert.equal(sqlite.prepare('SELECT count(*) n FROM direct_items').get().n,1);
   assert.ok(sqlite.prepare('SELECT last_checked_at FROM direct_source_interests').get().last_checked_at);
 }finally{sqlite.close();}
});

test('discovers a Telegram channel from mocked web search and reads public post',async()=>{
 const {db,sqlite}=await openDatabase(':memory:');
 const fetcher=async url=>{
   const u=String(url);
   if(u.includes('api.search.brave.com'))return Response.json({web:{results:[{title,url:'https://t.me/examplechan/123',description:title}]}});
   if(u==='https://t.me/robots.txt')return new Response('User-agent: *\nAllow: /');
   if(u==='https://t.me/s/examplechan')return new Response(`<div class="tgme_widget_message_wrap"><div data-post="examplechan/123"><div class="tgme_widget_message_text">${title}</div><time datetime="${new Date().toISOString()}"></time></div></div>`);
   throw Error('unexpected '+u);
 };
 try{const d=await direct.discoverDirectSources(db,interest,{key:'mock',fetcher});assert.equal(d.discovered[0].kind,'telegram');const r=await direct.monitorDirectSources(db,interest,{fetcher});assert.equal(r.items[0].url,'https://t.me/examplechan/123');assert.ok(r.items[0].publishedAt);}finally{sqlite.close();}
});

test('429 records incomplete and prevents another request during cooldown',async()=>{
 const {db,sqlite}=await openDatabase(':memory:');let calls=0;
 const fetcher=async()=>{calls++;return new Response('',{status:429,headers:{'Retry-After':'600'}});};
 try{const a=await direct.discoverDirectSources(db,interest,{fetcher});const b=await direct.discoverDirectSources(db,interest,{fetcher});assert.equal(a.incomplete,true);assert.equal(b.incomplete,true);assert.equal(calls,1);assert.equal(sqlite.prepare("SELECT count(*) n FROM direct_runs WHERE status='incomplete'").get().n,2);}finally{sqlite.close();}
});

test('generic university terms alone cannot satisfy a specific specialty interest',async()=>{
 const {db,sqlite}=await openDatabase(':memory:'); const query='تحديثات التسجيل في اختصاص التخدير بالجامعات الحكومية السورية';
 const fetcher=async url=>{const u=String(url);if(u.includes('news.google.com/rss/search'))return new Response('<rss><item><title>تعليمات التسجيل في اختصاص التخدير بالجامعات الحكومية السورية</title><link>https://news.google.com/rss/articles/one</link><source url="https://example.org">example</source></item></rss>');if(u.endsWith('/robots.txt'))return new Response('',{status:404});if(u.endsWith('/feed/'))return new Response('<rss><item><title>مواعيد التسجيل في الامتحان الطبي للجامعات الحكومية السورية</title><link>https://example.org/exam</link><description>التسجيل للجامعات الحكومية السورية</description></item></rss>');throw Error('publisher should not be opened');};
 try{await direct.discoverDirectSources(db,query,{fetcher});const result=await direct.monitorDirectSources(db,query,{fetcher});assert.equal(result.items.length,0);}finally{sqlite.close();}
});
