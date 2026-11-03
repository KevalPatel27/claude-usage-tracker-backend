/** Synthetic records in an isolated real MongoDB database; never writes collected usage. */
import mongoose from 'mongoose';
import request from 'supertest';
import { app } from '../src/app';
import { Admin, Checkpoint, Device, Person, UsageRecord } from '../src/models';
import { ingestDataPoints } from '../src/lib/ingestion';
import { parseOtlpMetricsPayload } from '../src/lib/otlp-parser';
const uri=process.env.TRACKER_TEST_MONGODB_URI;
const suite=uri?describe:describe.skip;
suite('Person and device lifecycle against real MongoDB',()=>{
 let cookie:string;
 beforeAll(async()=>{
  if(!uri?.startsWith('mongodb://127.0.0.1:'))throw Error('Only isolated loopback MongoDB allowed');
  await mongoose.connect(uri,{dbName:'tracker_management_test_'+Date.now()});
  await Promise.all([Person.init(),Device.init(),UsageRecord.init(),Checkpoint.init(),Admin.init()]);
  const r=await request(app).post('/api/auth/bootstrap').send({bootstrapSecret:process.env.ADMIN_BOOTSTRAP_SECRET,username:'admin',password:'isolated-test-password-123'});
  expect(r.status).toBe(201);cookie=r.headers['set-cookie'][0];
 });
 afterAll(async()=>{await mongoose.connection.dropDatabase();await mongoose.disconnect();});
 beforeEach(async()=>{await Promise.all([Person.deleteMany({}),Device.deleteMany({}),UsageRecord.deleteMany({}),Checkpoint.deleteMany({})]);});
 const call=(method:'get'|'post'|'patch'|'delete',path:string,body?:object)=>request(app)[method]('/api'+path).set('Cookie',cookie).send(body);
 const person=async(name='Person')=>(await call('post','/people',{name})).body;
 const device=async(personId?:string)=>(await call('post','/devices',{name:'Test PC',personId})).body;
 function payload(value=42,offset=10,begin=BigInt(Date.now())*1000000n-100n,temporality=2){return {resourceMetrics:[{scopeMetrics:[{metrics:[{name:'claude_code.token.usage',sum:{aggregationTemporality:temporality,isMonotonic:true,dataPoints:[{attributes:[{key:'model',value:{stringValue:'test-model'}},{key:'type',value:{stringValue:'input'}}],startTimeUnixNano:String(begin),timeUnixNano:String(begin+BigInt(offset)),asInt:String(value)}]}}]}]}]};}
 test('authenticated reads, validation and missing records',async()=>{
  expect((await request(app).get('/api/people')).status).toBe(401);
  expect((await call('get','/people/invalid')).status).toBe(400);
  expect((await call('get','/people/111111111111111111111111')).status).toBe(404);
  expect((await call('post','/people',{name:' '})).status).toBe(400);
  expect((await call('post','/devices',{name:'PC',personId:123})).status).toBe(400);
  const p=await person();expect((await call('patch','/people/'+p._id,{name:'Name',notes:'x'.repeat(2001)})).status).toBe(400);
 });
 test('person create, detail, edit, archive, restore and empty deletion',async()=>{
  const p=await person();const path='/people/'+p._id;
  expect((await call('patch',path,{name:'Updated',notes:'Context'})).body.notes).toBe('Context');
  expect((await call('get',path)).body.devices).toEqual([]);
  expect((await call('post',path+'/archive')).body.archivedAt).toBeTruthy();
  expect((await call('get','/people')).body).toHaveLength(0);
  expect((await call('get','/people?includeArchived=true')).body).toHaveLength(1);
  expect((await call('post','/devices',{name:'PC',personId:p._id})).status).toBe(409);
  expect((await call('post',path+'/restore')).body.archivedAt).toBeNull();
  expect((await call('delete',path)).status).toBe(204);
  expect((await call('get',path)).status).toBe(404);
 });
 test('device detail never exposes hashes; edit, archive, restore, reactivate and deletion guards',async()=>{
  const p=await person(),created=await device(p._id),path='/devices/'+created.device._id;
  let r=await call('get',path);expect(r.body.keyHash).toBeUndefined();expect(r.body.assignments[0].personId.name).toBe('Person');
  expect((await call('patch',path,{name:'Office PC',notes:'Windows'})).body.notes).toBe('Windows');
  expect((await call('delete',path)).status).toBe(409);
  expect((await call('post','/people/'+p._id+'/archive')).status).toBe(409);
  expect((await call('post',path+'/archive')).body.device.revokedAt).toBeTruthy();
  expect((await call('get','/devices')).body).toHaveLength(0);
  expect((await call('post',path+'/reactivate')).status).toBe(409);
  expect((await call('post',path+'/restore')).body.device.revokedAt).toBeTruthy();
  r=await call('post',path+'/reactivate');expect(r.body.rawKey).not.toBe(created.rawKey);
  expect((await request(app).post('/v1/metrics').set('X-Tracker-Key',created.rawKey).send(payload())).status).toBe(401);
  expect((await request(app).post('/v1/metrics').set('X-Tracker-Key',r.body.rawKey).send(payload())).status).toBe(200);
  await call('post',path+'/archive');expect((await call('delete',path)).status).toBe(409);
  expect(await UsageRecord.countDocuments()).toBe(1);
 });
 test('unused revoked device can be removed, followed by its empty person',async()=>{
  const p=await person(),d=await device(p._id),path='/devices/'+d.device._id;
  expect((await call('delete','/people/'+p._id)).status).toBe(409);
  await call('post',path+'/revoke');expect((await call('delete',path)).status).toBe(204);
  expect((await call('delete','/people/'+p._id)).status).toBe(204);
 });
 test('reassignment, unassignment and no-op changes preserve usage attribution',async()=>{
  const a=await person('A'),b=await person('B'),d=await device(a._id),path='/devices/'+d.device._id;
  await request(app).post('/v1/metrics').set('X-Tracker-Key',d.rawKey).send(payload());
  await call('patch',path+'/assign',{personId:a._id});expect((await call('get',path)).body.assignments).toHaveLength(1);
  expect((await call('patch',path+'/assign',{personId:b._id})).status).toBe(200);
  expect(String((await UsageRecord.findOne())!.personIdAtTime)).toBe(a._id);
  expect((await call('delete','/people/'+a._id)).status).toBe(409);
  expect((await call('post','/people/'+a._id+'/archive')).status).toBe(200);
  expect((await call('patch',path+'/assign',{personId:a._id})).status).toBe(409);
  expect((await call('patch',path+'/assign',{personId:null})).status).toBe(200);
  const current=(await call('get',path)).body;expect(current.personId).toBeNull();expect(current.assignments.every((a:{revokedAt?:string})=>a.revokedAt)).toBe(true);
 });
 test('concurrent first report and revocation/deletion cannot orphan usage or checkpoints',async()=>{
  for(let i=0;i<4;i++){
   const d=await device(),id=d.device._id;
   const points=parseOtlpMetricsPayload(payload()).flatMap(p=>p.dataPoints);
   await Promise.allSettled([ingestDataPoints(new mongoose.Types.ObjectId(id),null,points),call('post','/devices/'+id+'/revoke').then(()=>call('delete','/devices/'+id))]);
   const exists=await Device.exists({_id:id});const usage=await UsageRecord.countDocuments({deviceId:id}),cp=await Checkpoint.countDocuments({deviceId:id});
   if(!exists){expect(usage).toBe(0);expect(cp).toBe(0);}else{expect(usage).toBe(1);expect(cp).toBe(1);}
  }
 });
 test('concurrent person archive and device registration cannot activate an archived person',async()=>{
  const p=await person();await Promise.all([call('post','/people/'+p._id+'/archive'),device(p._id)]);
  const record=await Person.findById(p._id);if(record?.archivedAt)expect(await Device.countDocuments({personId:p._id,revokedAt:null})).toBe(0);
 });
 test('purge requires admin authentication and exact current name, including on empty records',async()=>{
  const p=await person(),d=await device(p._id);
  expect((await request(app).delete('/api/people/'+p._id+'?purge=true').send({confirmation:p.name})).status).toBe(401);
  expect((await call('delete','/people/'+p._id+'?purge=true',{confirmation:'wrong'})).status).toBe(409);
  expect((await call('delete','/devices/'+d.device._id+'?purge=true')).status).toBe(409);
  expect(await Person.countDocuments()).toBe(1);expect(await Device.countDocuments()).toBe(1);
 });
 test('permanent device deletion erases all usage/checkpoints, rejects old key and preserves other devices',async()=>{
  const p=await person(),a=await device(p._id),b=await device(p._id);
  await request(app).post('/v1/metrics').set('X-Tracker-Key',a.rawKey).send(payload());
  await request(app).post('/v1/metrics').set('X-Tracker-Key',b.rawKey).send(payload());
  expect((await call('delete','/devices/'+a.device._id+'?purge=true',{confirmation:a.device.name})).status).toBe(204);
  expect(await Device.findById(a.device._id)).toBeNull();expect(await UsageRecord.countDocuments({deviceId:a.device._id})).toBe(0);expect(await Checkpoint.countDocuments({deviceId:a.device._id})).toBe(0);
  expect((await request(app).post('/v1/metrics').set('X-Tracker-Key',a.rawKey).send(payload())).status).toBe(401);
  expect(await UsageRecord.countDocuments({deviceId:b.device._id})).toBe(1);expect(await Person.findById(p._id)).not.toBeNull();
 });
 test('person purge removes only their usage, revokes current devices and preserves a new owner’s totals',async()=>{
  const a=await person('A'),b=await person('B'),d=await device(a._id),current=await device(a._id),start=BigInt(Date.now()-60000)*1000000n;
  const send=(value:number,at:number)=>request(app).post('/v1/metrics').set('X-Tracker-Key',d.rawKey).send(payload(value,at,start));
  expect((await send(1000,10)).status).toBe(200);
  await call('patch','/devices/'+d.device._id+'/assign',{personId:b._id});expect((await send(1400,20)).status).toBe(200);
  expect((await call('delete','/people/'+a._id+'?purge=true',{confirmation:'A'})).status).toBe(204);
  expect(await Person.findById(a._id)).toBeNull();expect(await UsageRecord.countDocuments({personIdAtTime:a._id})).toBe(0);
  expect((await Device.findById(current.device._id))!.personId).toBeNull();expect((await Device.findById(current.device._id))!.revokedAt).toBeTruthy();
  const saved=(await Device.findById(d.device._id))!;expect(String(saved.personId)).toBe(b._id);expect(saved.assignments.some(x=>String(x.personId)===a._id)).toBe(false);
  expect((await UsageRecord.findOne({personIdAtTime:b._id}))!.deltaTokens).toBe(400);
  expect((await send(1000,10)).status).toBe(200);expect((await send(1200,15)).status).toBe(200);expect((await send(1400,20)).status).toBe(200);
  expect(await UsageRecord.countDocuments()).toBe(1);
  expect((await send(1700,30)).status).toBe(200);
  expect((await UsageRecord.aggregate([{$group:{_id:null,total:{$sum:'$deltaTokens'}}}]))[0].total).toBe(700);
  const response=await call('get','/dashboard/overview');expect(response.body.totalsByType[0].total).toBe(700);
  const csv=await call('get','/dashboard/export.csv');expect(csv.text.trim().split('\r\n').slice(1).reduce((n:number,l:string)=>n+Number(l.split(',').at(-1)!.replace(/"/g,'')),0)).toBe(700);
 });
 test('purge baseline survives reconnect; resets, new sessions and late cumulative splits remain correct',async()=>{
  const a=await person('A'),b=await person('B'),d=await device(a._id),start=BigInt(Date.now()-60000)*1000000n;
  const send=(value:number,at:number,begin=start)=>request(app).post('/v1/metrics').set('X-Tracker-Key',d.rawKey).send(payload(value,at,begin));
  await send(1000,10);await call('delete','/people/'+a._id+'?purge=true',{confirmation:'A'});
  await call('patch','/devices/'+d.device._id+'/assign',{personId:b._id});const revived=await call('post','/devices/'+d.device._id+'/reactivate');
  const sendNew=(value:number,at:number,begin=start)=>request(app).post('/v1/metrics').set('X-Tracker-Key',revived.body.rawKey).send(payload(value,at,begin));
  const database=mongoose.connection.name;await mongoose.disconnect();await mongoose.connect(uri!,{dbName:database});
  await sendNew(1000,10);await sendNew(1600,30);await sendNew(1300,20);
  expect((await UsageRecord.find().sort({timeUnixNano:1})).map(r=>r.deltaTokens)).toEqual([300,300]);
  await sendNew(100,40);await sendNew(50,10,start+100n);
  expect((await UsageRecord.aggregate([{$group:{_id:null,total:{$sum:'$deltaTokens'}}}]))[0].total).toBe(750);
 });
 test('concurrent device purge and incoming report cannot resurrect data or orphan checkpoints',async()=>{
  for(let i=0;i<3;i++){
   const d=await device(),id=d.device._id;await Promise.allSettled([request(app).post('/v1/metrics').set('X-Tracker-Key',d.rawKey).send(payload()),call('delete','/devices/'+id+'?purge=true',{confirmation:d.device.name})]);
   expect(await Device.findById(id)).toBeNull();expect(await UsageRecord.countDocuments({deviceId:id})).toBe(0);expect(await Checkpoint.countDocuments({deviceId:id})).toBe(0);
  }
 });
 test('delta exports crossing a purge boundary reject, while later disjoint intervals count once',async()=>{
  const a=await person('A'),b=await person('B'),d=await device(a._id),start=BigInt(Date.now()-60000)*1000000n;
  const send=(value:number,offset:number,begin:bigint)=>request(app).post('/v1/metrics').set('X-Tracker-Key',d.rawKey).send(payload(value,offset,begin,1));
  await send(100,10,start);await call('patch','/devices/'+d.device._id+'/assign',{personId:b._id});
  await call('delete','/people/'+a._id+'?purge=true',{confirmation:'A'});
  expect((await send(100,10,start+5n)).status).toBe(400);
  expect((await send(100,10,start)).status).toBe(200);
  expect((await send(50,10,start+10n)).status).toBe(200);expect((await send(50,10,start+10n)).status).toBe(200);
  expect(await UsageRecord.countDocuments()).toBe(1);expect((await UsageRecord.findOne())!.deltaTokens).toBe(50);
 });
 test('concurrent person purge and report leave no usage or assignment pointing to the deleted person',async()=>{
  const p=await person(),d=await device(p._id);
  await Promise.allSettled([request(app).post('/v1/metrics').set('X-Tracker-Key',d.rawKey).send(payload()),call('delete','/people/'+p._id+'?purge=true',{confirmation:p.name})]);
  expect(await Person.findById(p._id)).toBeNull();expect(await UsageRecord.countDocuments({personIdAtTime:p._id})).toBe(0);
  const saved=(await Device.findById(d.device._id))!;expect(saved.personId).toBeNull();expect(saved.revokedAt).toBeTruthy();expect(saved.assignments).toHaveLength(0);
  expect((await request(app).post('/v1/metrics').set('X-Tracker-Key',d.rawKey).send(payload())).status).toBe(401);
 });
});
