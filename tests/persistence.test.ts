import { spawn, ChildProcess } from 'child_process';
/** Synthetic OTLP fixtures; these are NOT captured Desktop telemetry. Real MongoDB, no model mocks except injected failure. */
import mongoose from 'mongoose';
import request from 'supertest';
import { app } from '../src/app';
import { Admin, Checkpoint, Device, Person, UsageRecord } from '../src/models';
import { generateDeviceKey } from '../src/lib/crypto';
import { parseOtlpMetricsPayload } from '../src/lib/otlp-parser';
import { ingestDataPoints } from '../src/lib/ingestion';
import { usageQuery, csvCell } from '../src/lib/query';
const uri=process.env.TRACKER_TEST_MONGODB_URI;
const suite=uri?describe:describe.skip;
const start=BigInt(Date.now()-60000)*1000000n;
function payload(value:number,t=10,session='session-a',temporality=2,begin=start) {
 return {resourceMetrics:[{resource:{attributes:[{key:'service.name',value:{stringValue:'claude-code'}}]},scopeMetrics:[{scope:{name:'claude-code'},metrics:[{name:'claude_code.token.usage',sum:{aggregationTemporality:temporality,isMonotonic:true,dataPoints:[{attributes:[{key:'model',value:{stringValue:'test-model'}},{key:'type',value:{stringValue:'input'}},{key:'session.id',value:{stringValue:session}}],startTimeUnixNano:String(begin),timeUnixNano:String(start+BigInt(t)),asInt:String(value)}]}}]}]}]};
}
suite('Real MongoDB authenticated ingestion',()=>{
 let device:mongoose.Types.ObjectId,person:mongoose.Types.ObjectId,key:string,cookie:string;
 const database='tracker_test_'+Date.now();
 beforeAll(async()=>{
  if(!uri?.startsWith('mongodb://127.0.0.1:')) throw new Error('Tests only allow isolated loopback MongoDB');
  await mongoose.connect(uri,{dbName:database,serverSelectionTimeoutMS:5000});
  await Promise.all([Admin.init(),Checkpoint.init(),Device.init(),Person.init(),UsageRecord.init()]);
 });
 afterAll(async()=>{await mongoose.connection.dropDatabase();await mongoose.disconnect();});
 beforeEach(async()=>{
  await Promise.all([Admin.deleteMany({}),Checkpoint.deleteMany({}),Device.deleteMany({}),Person.deleteMany({}),UsageRecord.deleteMany({})]);
  person=(await Person.create({name:'Assigned person'}))._id;
  const k=generateDeviceKey();key=k.rawKey;
  device=(await Device.create({name:'Test PC',personId:person,keyHash:k.keyHash,keyPrefix:k.keyPrefix}))._id;
  const r=await request(app).post('/api/auth/bootstrap').send({bootstrapSecret:process.env.ADMIN_BOOTSTRAP_SECRET,username:'admin',password:'a-test-password-123'});
  expect(r.status).toBe(201);cookie=r.headers['set-cookie'][0];
 });
 const total=async()=> (await UsageRecord.aggregate([{$group:{_id:null,total:{$sum:'$deltaTokens'}}}]))[0]?.total??0;
 const send=(key:string,p:object)=>request(app).post('/v1/metrics').set('X-Tracker-Key',key).send(p);
 test('actual mounted HTTP endpoint, cumulative increments and retries',async()=>{
  expect((await send(key,payload(1000))).status).toBe(200);
  expect((await send(key,payload(1400,20))).status).toBe(200);
  expect((await send(key,payload(1400,20))).status).toBe(200);
  expect(await total()).toBe(1400);
  expect(await UsageRecord.countDocuments()).toBe(2);
 });
 test('out-of-order reports split adjacent deltas instead of overcounting',async()=>{
  await send(key,payload(1400,20));await send(key,payload(1000,10));await send(key,payload(1200,15));
  expect(await total()).toBe(1400);
  expect((await UsageRecord.find().sort({timeUnixNano:1})).map(x=>x.deltaTokens)).toEqual([1000,200,200]);
 });
 test('concurrent requests serialize and duplicate exports deduplicate',async()=>{
  const results=await Promise.all([send(key,payload(1000)),send(key,payload(1400,20)),send(key,payload(1400,20)),send(key,payload(1200,15))]);
  expect(results.map(r=>r.status)).toEqual([200,200,200,200]);expect(await total()).toBe(1400);
 });
 test('multiple sessions and devices remain independent',async()=>{
  const k=generateDeviceKey();await Device.create({name:'PC B',personId:person,keyHash:k.keyHash,keyPrefix:k.keyPrefix});
  await Promise.all([send(key,payload(1000,10,'a')),send(key,payload(500,10,'b')),send(k.rawKey,payload(700))]);
  expect(await total()).toBe(2200);
 });
 test('reset with new start and reset with unchanged start are counted once',async()=>{
  await send(key,payload(1000));await send(key,payload(200,20));await send(key,payload(400,30));
  await send(key,payload(50,40,'session-a',2,start+35n));
  expect(await total()).toBe(1450);
 });
 test('nanosecond exports in the same millisecond remain distinct',async()=>{
  await send(key,payload(1000,1));await send(key,payload(1400,2));expect(await total()).toBe(1400);expect(await UsageRecord.countDocuments()).toBe(2);
 });
 test('checkpoint and dedup state survive disconnect and fresh connection',async()=>{
  await send(key,payload(1000));await mongoose.disconnect();await mongoose.connect(uri!,{dbName:database});
  await send(key,payload(1000));await send(key,payload(1400,20));expect(await total()).toBe(1400);
 });
 test('fresh backend processes resume persisted counters after actual process restart',async()=>{
  const parsed=new URL(uri!);parsed.pathname='/'+database;
  async function boot():Promise<{child:ChildProcess;port:number}>{
   const child=spawn(process.execPath,['dist/index.js'],{cwd:process.cwd(),env:{...process.env,MONGODB_URI:parsed.toString(),PORT:'0',HOST:'127.0.0.1'},stdio:['ignore','pipe','pipe']});
   return await new Promise((resolve,reject)=>{
    const timeout=setTimeout(()=>{child.kill();reject(new Error('Backend subprocess startup timed out; run npm run build before integration tests'));},10000);
    child.once('error',e=>{clearTimeout(timeout);reject(e);});
    child.stdout!.on('data',b=>{const m=String(b).match(/Ready (\d+)/);if(m){clearTimeout(timeout);resolve({child,port:Number(m[1])});}});
    child.once('exit',code=>{clearTimeout(timeout);if(code)reject(new Error('Backend subprocess exited before ready'));});
   });
  }
  async function stop(child:ChildProcess){await new Promise<void>(resolve=>{child.once('exit',()=>resolve());child.kill();});}
  let running=await boot();
  try {
   expect((await request('http://127.0.0.1:'+running.port).post('/v1/metrics').set('X-Tracker-Key',key).send(payload(1000))).status).toBe(200);
   await stop(running.child);running=await boot();
   for(const p of [payload(1000),payload(1400,20)]) expect((await request('http://127.0.0.1:'+running.port).post('/v1/metrics').set('X-Tracker-Key',key).send(p)).status).toBe(200);
   expect(await total()).toBe(1400);
  } finally {await stop(running.child);}
 });
 test('delta retry, out-of-order nonoverlapping intervals, overlapping rejection',async()=>{
  await send(key,payload(200,20,'a',1,start+10n));await send(key,payload(100,10,'a',1,start));
  await send(key,payload(200,20,'a',1,start+10n));expect(await total()).toBe(300);
  expect((await send(key,payload(900,25,'a',1,start+15n))).status).toBe(400);expect(await total()).toBe(300);
 });
 test('injected DB write failure rolls back and returns retryable 503; retry succeeds',async()=>{
  const original=UsageRecord.create;
  const spy=jest.spyOn(UsageRecord,'create').mockImplementationOnce((()=>Promise.reject(new Error('injected DB failure'))) as unknown as typeof original);
  const r=await send(key,payload(1000));spy.mockRestore();expect(r.status).toBe(503);expect(r.headers['retry-after']).toBe('5');
  expect(await total()).toBe(0);expect((await Device.findById(device))?.lastReportAt).toBeNull();
  await send(key,payload(1000));expect(await total()).toBe(1000);
 });
 test('invalid/revoked/rotated keys and admin key separation',async()=>{
  expect((await send('dkey_'+'0'.repeat(64),payload(1000))).status).toBe(401);
  expect((await request(app).get('/api/dashboard/overview').set('X-Tracker-Key',key)).status).toBe(401);
  expect((await request(app).post('/v1/metrics').set('Cookie',cookie).send(payload(1000))).status).toBe(401);
  const rotate=await request(app).post('/api/devices/'+device+'/rotate-key').set('Cookie',cookie).send({});expect(rotate.status).toBe(200);
  expect((await send(key,payload(1000))).status).toBe(401);key=rotate.body.rawKey;
  expect((await send(key,payload(1000))).status).toBe(200);
  await request(app).post('/api/devices/'+device+'/revoke').set('Cookie',cookie).send({});
  expect((await send(key,payload(1400,20))).status).toBe(401);
 });
 test('historical reassignment keeps old usage and attributes only new increments',async()=>{
  await send(key,payload(1000));const other=await Person.create({name:'New assignee'});
  await request(app).patch('/api/devices/'+device+'/assign').set('Cookie',cookie).send({personId:other._id});
  await send(key,payload(1400,20));const records=await UsageRecord.find().sort({timeUnixNano:1});
  expect(records.map(r=>[String(r.personIdAtTime),r.deltaTokens])).toEqual([[String(person),1000],[String(other._id),400]]);
 });
 test('late cumulative export after reassignment does not transfer already-accounted usage',async()=>{
  await send(key,payload(1400,20));const other=await Person.create({name:'New assignee'});
  await request(app).patch('/api/devices/'+device+'/assign').set('Cookie',cookie).send({personId:other._id});
  await send(key,payload(1000,10));await send(key,payload(1500,30));
  const rows=await UsageRecord.aggregate([{$group:{_id:'$personIdAtTime',total:{$sum:'$deltaTokens'}}}]);
  expect(rows.find(r=>String(r._id)===String(person)).total).toBe(1400);
  expect(rows.find(r=>String(r._id)===String(other._id)).total).toBe(100);
 });
 test('dashboard, detail APIs, trend and CSV agree under the same filters',async()=>{
  await send(key,payload(1000));await send(key,payload(1400,20));
  const overview=await request(app).get('/api/dashboard/overview?timezone=Asia/Kolkata').set('Cookie',cookie);
  expect(overview.status).toBe(200);expect(overview.body.totalsByType[0].total).toBe(1400);expect(overview.body.dailyTrend[0].totalTokens).toBe(1400);
  expect(overview.body.byPerson[0].personId).toBe(String(person));expect(overview.body.byDevice[0]._id).toBe(String(device));
  const csv=await request(app).get('/api/dashboard/export.csv?timezone=Asia/Kolkata').set('Cookie',cookie);
  expect(csv.status).toBe(200);expect(csv.text.trim().split('\r\n').slice(1).reduce((s,r)=>s+Number(r.split(',').at(-1)?.replace(/"/g,'')),0)).toBe(1400);
  for(const p of ['devices/'+device,'people/'+person]) {
   const r=await request(app).get('/api/'+p+'/usage').set('Cookie',cookie);expect(r.body.records[0].totalTokens).toBe(1400);
   const csv=await request(app).get('/api/'+p+'/export.csv').set('Cookie',cookie);expect(csv.text).toContain('test-model');
  }
 });
 test('hourly/daily graph increments and model costs agree with totals and CSV',async()=>{
  const previous=process.env.MODEL_RATES_JSON;
  process.env.MODEL_RATES_JSON=JSON.stringify({'test-model':{input:5,output:25,cacheRead:.5,cacheCreation:6.25}});
  try {
   await send(key,payload(1000));await send(key,payload(1400,20));
   const from=new Date(Date.now()-3600000).toISOString(),to=new Date(Date.now()+3600000).toISOString();
   const response=await request(app).get('/api/dashboard/overview').query({from,to,timezone:'Asia/Kolkata'}).set('Cookie',cookie);
   expect(response.status).toBe(200);expect(response.body.trendGranularity).toBe('hour');
   expect(response.body.trend.reduce((n:number,r:{totalTokens:number})=>n+r.totalTokens,0)).toBe(1400);
   expect(response.body.trend.reduce((n:number,r:{input:number})=>n+r.input,0)).toBe(1400);
   expect(response.body.estimatedCostUsd).toBeCloseTo(.007,10);
   expect(response.body.trend.reduce((n:number,r:{estimatedCostUsd:number})=>n+r.estimatedCostUsd,0)).toBeCloseTo(.007,10);
   expect(response.body.costByModel[0].estimatedCostUsd).toBeCloseTo(.007,10);
   const daily=await request(app).get('/api/dashboard/overview').set('Cookie',cookie);expect(daily.body.trendGranularity).toBe('day');expect(daily.body.trend[0].totalTokens).toBe(1400);
   const csv=await request(app).get('/api/dashboard/export.csv').query({from,to,timezone:'Asia/Kolkata'}).set('Cookie',cookie);
   expect(csv.text.trim().split('\r\n').slice(1).reduce((n:number,row:string)=>n+Number(row.split(',').at(-1)?.replace(/"/g,'')),0)).toBe(1400);
   const csvRows=csv.text.trim().split('\r\n');const costIndex=csvRows[0].split(',').indexOf('estimatedApiCostUsd');expect(costIndex).toBeGreaterThan(-1);expect(csvRows.slice(1).reduce((n:number,row:string)=>n+Number(row.split(',')[costIndex].replace(/"/g,'')),0)).toBeCloseTo(.007,10);
  } finally {if(previous===undefined)delete process.env.MODEL_RATES_JSON;else process.env.MODEL_RATES_JSON=previous;}
 });
 test('bundled mixed Haiku/Opus rates agree across authenticated API, charts and CSV',async()=>{
  const previous=process.env.MODEL_RATES_JSON;delete process.env.MODEL_RATES_JSON;
  try{
   const opus=payload(1000),haiku=payload(1000);
   opus.resourceMetrics[0].scopeMetrics[0].metrics[0].sum.dataPoints[0].attributes[0].value.stringValue='claude-opus-5';
   haiku.resourceMetrics[0].scopeMetrics[0].metrics[0].sum.dataPoints[0].attributes[0].value.stringValue='claude-haiku-5-5';
   expect((await send(key,opus)).status).toBe(200);expect((await send(key,haiku)).status).toBe(200);
   const response=await request(app).get('/api/dashboard/overview').set('Cookie',cookie);
   expect(response.body.pricing.unpricedModels).toEqual([]);expect(response.body.pricing.catalog).toHaveLength(20);
   expect(response.body.estimatedCostUsd).toBeCloseTo(.0051,10);
   expect(response.body.trend.reduce((n:number,r:{estimatedCostUsd:number})=>n+r.estimatedCostUsd,0)).toBeCloseTo(.0051,10);
   expect(response.body.costByModel).toHaveLength(2);
   const csv=await request(app).get('/api/dashboard/export.csv').set('Cookie',cookie),lines=csv.text.trim().split('\r\n');
   const col=lines[0].split(',').indexOf('estimatedApiCostUsd');
   expect(lines.slice(1).reduce((n:number,row:string)=>n+Number(row.split(',')[col].replace(/"/g,'')),0)).toBeCloseTo(.0051,10);
  }finally{if(previous===undefined)delete process.env.MODEL_RATES_JSON;else process.env.MODEL_RATES_JSON=previous;}
 });
 test('readable sessions aggregate by device and agree with filtered dashboard, cost and CSV',async()=>{
  const previous=process.env.MODEL_RATES_JSON;process.env.MODEL_RATES_JSON=JSON.stringify({'test-model':{input:5,output:25,cacheRead:.5,cacheCreation:6.25}});
  try{
   await send(key,payload(1000,10,'session-a'));await send(key,payload(1400,20,'session-a'));await send(key,payload(500,10,'session-b'));
   const other=generateDeviceKey();await Device.create({name:'Second PC',personId:person,keyHash:other.keyHash,keyPrefix:other.keyPrefix});await send(other.rawKey,payload(700,10,'session-a'));
   const missing=payload(200,10,'missing');missing.resourceMetrics[0].scopeMetrics[0].metrics[0].sum.dataPoints[0].attributes.pop();await send(key,missing);
   const sessions=await request(app).get('/api/dashboard/sessions').set('Cookie',cookie);
   expect(sessions.status).toBe(200);expect(sessions.body.knownSessionCount).toBe(3);expect(sessions.body.totalGroups).toBe(4);expect(sessions.body.unattributedTokens).toBe(200);
   expect(sessions.body.rows.reduce((n:number,r:{totalTokens:number})=>n+r.totalTokens,0)).toBe(2800);
   expect(sessions.body.rows.reduce((n:number,r:{estimatedCostUsd:number})=>n+r.estimatedCostUsd,0)).toBeCloseTo(.014,10);
   const scope={sessionId:'session-a',deviceId:String(device)};
   const overview=await request(app).get('/api/dashboard/overview').query(scope).set('Cookie',cookie);
   expect(overview.body.totalsByType[0].total).toBe(1400);expect(overview.body.estimatedCostUsd).toBeCloseTo(.007,10);
   const filtered=await request(app).get('/api/dashboard/sessions').query(scope).set('Cookie',cookie);expect(filtered.body.rows).toHaveLength(1);expect(filtered.body.rows[0].sessionId).toBe('session-a');expect(filtered.body.rows[0].totalTokens).toBe(1400);
   const csv=await request(app).get('/api/dashboard/export.csv').query(scope).set('Cookie',cookie),rows=csv.text.trim().split('\r\n'),sessionColumn=rows[0].split(',').indexOf('sessionId');expect(sessionColumn).toBeGreaterThan(-1);
   expect(rows.slice(1).every((r:string)=>r.split(',')[sessionColumn]==='"session-a"')).toBe(true);expect(rows.slice(1).reduce((n:number,r:string)=>n+Number(r.split(',').at(-1)!.replace(/"/g,'')),0)).toBe(1400);
   expect((await request(app).get('/api/dashboard/sessions')).status).toBe(401);
   expect((await request(app).get('/api/dashboard/sessions').query({page:'-1'}).set('Cookie',cookie)).status).toBe(400);
   expect((await request(app).get('/api/dashboard/overview').query({sessionId:'a b'}).set('Cookie',cookie)).status).toBe(400);
  }finally{if(previous===undefined)delete process.env.MODEL_RATES_JSON;else process.env.MODEL_RATES_JSON=previous;}
 });
 test('matching retries can fill a legacy missing session ID without changing counters or identities',async()=>{
  const p=payload(1000,10,'recoverable-id');await send(key,p);const before=(await UsageRecord.findOne())!;
  await UsageRecord.updateOne({_id:before._id},{$unset:{sessionId:1}});await send(key,p);
  const after=(await UsageRecord.findOne())!;expect(after.sessionId).toBe('recoverable-id');expect(after.seriesKey).toBe(before.seriesKey);expect(await total()).toBe(1000);expect(await UsageRecord.countDocuments()).toBe(1);
  await UsageRecord.updateOne({_id:before._id},{$unset:{sessionId:1}});await send(key,payload(1400,20,'recoverable-id'));
  expect((await UsageRecord.find()).every(r=>r.sessionId==='recoverable-id')).toBe(true);expect(await total()).toBe(1400);
 });
 test('session pagination is stable and missing-ID buckets are not counted as sessions',async()=>{
  for(let i=0;i<27;i++){const p=payload(1,10,'page-'+String(i).padStart(2,'0'));await ingestDataPoints(device,person,parseOtlpMetricsPayload(p)[0].dataPoints);}
  const a=await request(app).get('/api/dashboard/sessions').set('Cookie',cookie),b=await request(app).get('/api/dashboard/sessions?page=1').set('Cookie',cookie);
  expect(a.body.rows).toHaveLength(25);expect(a.body.hasMore).toBe(true);expect(b.body.rows).toHaveLength(2);expect(b.body.hasMore).toBe(false);expect(new Set([...a.body.rows,...b.body.rows].map(r=>r.sessionId)).size).toBe(27);
 });
 test('receipt verification requires usage after supplied onboarding time',async()=>{
  const since=new Date().toISOString();await send(key,{resourceMetrics:[]});
  let r=await request(app).get('/api/dashboard/verify-device/'+device+'?since='+encodeURIComponent(since)).set('Cookie',cookie);expect(r.body.verified).toBe(false);
  await send(key,payload(1000));r=await request(app).get('/api/dashboard/verify-device/'+device+'?since='+encodeURIComponent(since)).set('Cookie',cookie);expect(r.body.verified).toBe(true);
 });
 test('malformed payloads, missing temporality, unsafe integers and content type are rejected',async()=>{
  expect((await send(key,{invalid:true})).status).toBe(400);
  const p=payload(1);delete (p.resourceMetrics[0].scopeMetrics[0].metrics[0].sum as {aggregationTemporality?:number}).aggregationTemporality;
  expect((await send(key,p)).status).toBe(400);
  expect((await send(key,payload(Number.MAX_SAFE_INTEGER+1))).status).toBe(400);
  expect((await request(app).post('/v1/metrics').set('X-Tracker-Key',key).type('text').send('bad')).status).toBe(415);
 });
});
describe('Date and export validation',()=>{
 test('IANA timezone calendar range includes complete local day',()=>{
  const q=usageQuery({from:'2026-11-02',to:'2026-11-02',timezone:'Asia/Kolkata'});
  expect(q.from.toISOString()).toBe('2026-11-01T18:30:00.000Z');expect(q.to.toISOString()).toBe('2026-11-02T18:30:00.000Z');
 });
 test('DST boundary day is 23 hours',()=>{const q=usageQuery({from:'2026-03-08',to:'2026-03-08',timezone:'America/New_York'});expect(q.to.getTime()-q.from.getTime()).toBe(23*3600000);});
 test('invalid dates, timezone and unbounded queries reject',()=>{for(const q of [{from:'2026-02-30'},{timezone:'invalid'},{from:'2020-01-01'}])expect(()=>usageQuery(q)).toThrow();});
 test('CSV quotes embedded quotes and neutralizes formulas',()=>{expect(csvCell('a,"b')).toBe('"a,""b"');expect(csvCell('=cmd')).toBe('"\'=cmd"');});
 test('different session dimensions produce independent identities',()=>{const a=parseOtlpMetricsPayload(payload(1,10,'a'))[0].dataPoints[0],b=parseOtlpMetricsPayload(payload(1,10,'b'))[0].dataPoints[0];expect(a.identityHash).not.toBe(b.identityHash);});
});
