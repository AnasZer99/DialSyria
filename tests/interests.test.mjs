import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { DatabaseSync } from 'node:sqlite';
import { loadInterests, openDatabase } from '../scripts/discovery-runtime.mjs';

const api=await loadInterests();

async function setup() {
  const {db,sqlite}=await openDatabase(':memory:');
  sqlite.exec(await readFile('schema.sql','utf8'));
  sqlite.prepare('INSERT INTO subscribers (id,email,status,created_at,magic_token,magic_expires) VALUES (?,?,?,?,?,?)').run('a','a@example.test','active','2026-01-01','token-a','2999-01-01T00:00:00.000Z');
  sqlite.prepare('INSERT INTO subscribers (id,email,status,created_at,magic_token,magic_expires) VALUES (?,?,?,?,?,?)').run('b','b@example.test','active','2026-01-01','token-b','2999-01-01T00:00:00.000Z');
  sqlite.prepare('INSERT INTO subscribers (id,email,status,created_at,magic_token,magic_expires) VALUES (?,?,?,?,?,?)').run('expired','expired@example.test','active','2026-01-01','expired-token','2000-01-01T00:00:00.000Z');
  return {db,sqlite};
}

async function request(db,method,token,body,query='') {
  const headers={}; if(token)headers.authorization='Bearer '+token;
  if(body!==undefined)headers['content-type']='application/json';
  const req=new Request('https://example.test/api/interests'+query,{method,headers,...(body!==undefined?{body:JSON.stringify(body)}:{})});
  const handler={GET:api.onRequestGet,POST:api.onRequestPost,PATCH:api.onRequestPatch,DELETE:api.onRequestDelete}[method];
  const response=await handler({request:req,env:{DB:db},params:{},waitUntil(){}});
  return {status:response.status,body:await response.json()};
}

test('subscriber CRUD and normalized duplicates preserve legacy topics',async()=>{
  const {db,sqlite}=await setup();
  try {
    sqlite.prepare('INSERT INTO subscriber_topics (subscriber_id,topic) VALUES (?,?)').run('a','politics');
    const created=await request(db,'POST','token-a',{text:'  قرارات البناء في إدلب  '});
    assert.equal(created.status,201); assert.equal(created.body.interest.text,'قرارات البناء في إدلب');
    const duplicate=await request(db,'POST','token-a',{text:'قرارات البناء في ادلب!!!'}); assert.equal(duplicate.status,409);
    const id=created.body.interest.id;
    assert.equal((await request(db,'GET','token-a')).body.interests.length,1);
    assert.equal((await request(db,'PATCH','token-a',{id,text:'أخبار الجامعات في حلب'})).status,200);
    assert.equal((await request(db,'GET','token-a')).body.interests[0].text,'أخبار الجامعات في حلب');
    assert.equal((await request(db,'DELETE','token-a',undefined,'?id='+id)).status,200);
    assert.equal((await request(db,'GET','token-a')).body.interests.length,0);
    assert.equal(sqlite.prepare('SELECT count(*) n FROM subscriber_topics').get().n,1);
  } finally {sqlite.close();}
});

test('access is scoped to token owner; email and foreign IDs cannot grant access',async()=>{
  const {db,sqlite}=await setup();
  try {
    const a=await request(db,'POST','token-a',{text:'فرص العمل في إدلب'}); const id=a.body.interest.id;
    assert.deepEqual((await request(db,'GET','token-b')).body.interests,[]);
    assert.equal((await request(db,'PATCH','token-b',{id,text:'اهتمام مستبدل'})).status,404);
    assert.equal((await request(db,'DELETE','token-b',undefined,'?id='+id)).status,404);
    assert.equal((await request(db,'GET',null,undefined,'?email=a@example.test')).status,401);
    assert.equal((await request(db,'GET','expired-token')).status,401);
    assert.equal((await request(db,'POST','token-b',{text:'أخبار الجامعات',subscriber_id:'a',email:'a@example.test'})).status,201);
    assert.equal((await request(db,'GET','token-a')).body.interests[0].text,'فرص العمل في إدلب');
    assert.equal((await request(db,'GET','token-b')).body.interests.length,1);
    assert.equal((await request(db,'GET',null,undefined,'?token=token-a')).body.interests.length,1);
    assert.equal((await request(db,'POST','token-b',{text:'فرص العمل في ادلب'})).status,201);
    assert.ok(!JSON.stringify(a.body).includes('token-a'));
  } finally {sqlite.close();}
});

test('validates input, enforces limits, and rejects update collisions',async()=>{
  const {db,sqlite}=await setup();
  try {
    for(const text of ['', '!!', 'ab', 'a'.repeat(301), 'abc\u0000def', 123]) assert.equal((await request(db,'POST','token-a',{text})).status,400);
    const ids=[];
    for(let i=0;i<10;i++){const r=await request(db,'POST','token-a',{text:'اهتمام رقم '+i});assert.equal(r.status,201);ids.push(r.body.interest.id);}
    assert.equal((await request(db,'POST','token-a',{text:'اهتمام إضافي'})).status,409);
    assert.equal((await request(db,'PATCH','token-a',{id:ids[0],text:'اهتمام رقم 1'})).status,409);
    assert.equal((await request(db,'PATCH','token-a',{id:'unknown',text:'اهتمام جديد'})).status,404);
  } finally {sqlite.close();}
});

test('additive migration preserves existing subscribers and topics in an isolated database',async()=>{
  const sqlite=new DatabaseSync(':memory:');
  try {
    sqlite.exec(await readFile('schema.sql','utf8'));
    sqlite.prepare('INSERT INTO subscribers (id,email,created_at) VALUES (?,?,?)').run('a','a@example.test','2026-01-01');
    sqlite.prepare('INSERT INTO subscriber_topics (subscriber_id,topic) VALUES (?,?)').run('a','politics');
    const migration=await readFile('migrations/0004_subscriber_interests.sql','utf8');
    sqlite.exec(migration); sqlite.exec(migration);
    assert.equal(sqlite.prepare('SELECT count(*) n FROM subscribers').get().n,1);
    assert.equal(sqlite.prepare('SELECT count(*) n FROM subscriber_topics').get().n,1);
    assert.equal(sqlite.prepare('SELECT count(*) n FROM subscriber_interests').get().n,0);
  } finally {sqlite.close();}
});
