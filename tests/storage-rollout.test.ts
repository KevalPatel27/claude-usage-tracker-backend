/** Real MongoDB, isolated DB. Tests dual-write, rollback, backfill, and transaction abort. */
import mongoose from 'mongoose';
import {Device,Person,Checkpoint,UsageRecord} from '../src/models/index';
import {initStorage,UsageBucket,backfillStream,refreshReadMode,usageAggregate,STORAGE_VERSION} from '../src/lib/storage';
import {ingestDataPoints} from '../src/lib/ingestion';
import {verifyStorage} from '../src/scripts/storage-rollout';
import {generateDeviceKey} from '../src/lib/crypto';
const uri=process.env.TRACKER_TEST_MONGODB_URI;
const suite=uri&&process.env.STORAGE_MODE==='mirror'?describe:describe.skip;
const start=BigInt(Date.UTC(2026,10,4))*1000000n;
suite('Transactional storage rollout',()=>{
 const database='tracker_test_rollout_'+Date.now();let device:mongoose.Types.ObjectId,person:mongoose.Types.ObjectId;
 const dp=(v:number,t:number)=>({sessionId:'rollout-session',identityHash:'rollout-session',model:'test-model',tokenType:'input',querySource:'main',startTimeUnixNano:String(start),timeUnixNano:String(start+BigInt(t)),asInt:v,aggregationTemporality:2,isMonotonic:true});
 const send=(v:number,t:number)=>ingestDataPoints(device,person,[dp(v,t)]);
 beforeAll(async()=>{if(!uri!.startsWith('mongodb://127.0.0.1:'))throw new Error('Loopback tests only');await mongoose.connect(uri!,{dbName:database});await Promise.all([Device.init(),Person.init(),Checkpoint.init(),UsageRecord.init()]);await initStorage();});
 beforeEach(async()=>{await Promise.all([Device.deleteMany({}),Person.deleteMany({}),Checkpoint.deleteMany({}),UsageRecord.deleteMany({}),UsageBucket.deleteMany({}),mongoose.connection.db!.collection('storageRollout').deleteMany({})]);await refreshReadMode();person=(await Person.create({name:'Rollout test'}))._id;const k=generateDeviceKey();device=(await Device.create({name:'Test device',personId:person,keyPrefix:k.keyPrefix,keyHash:k.keyHash}))._id;});
 afterAll(async()=>{await mongoose.connection.dropDatabase();await mongoose.disconnect();});
 test('new, late, concurrent, duplicate and reset exports keep full document parity',async()=>{
  await send(1000,10);await send(1600,30);await send(1200,20);await Promise.all([send(1800,40),send(1800,40),send(2000,50)]);await send(50,60);
  expect((await verifyStorage()).total).toBe(2050);
 });
 test('raw readers, compact readers and rollback include new post-cutover reports',async()=>{
  await send(1000,10);const proof=await verifyStorage();await mongoose.connection.db!.collection('storageRollout').updateOne({_id:STORAGE_VERSION as any},{$set:{...proof,readMode:'compact'}},{upsert:true});await refreshReadMode();
  await send(1500,20);const pipeline=[{$group:{_id:null,total:{$sum:'$deltaTokens'}}}];expect((await usageAggregate(pipeline))[0].total).toBe(1500);
  await mongoose.connection.db!.collection('storageRollout').updateOne({_id:STORAGE_VERSION as any},{$set:{readMode:'raw'}});await refreshReadMode();expect((await usageAggregate(pipeline))[0].total).toBe(1500);expect((await verifyStorage()).total).toBe(1500);
 });
 test('historical stream backfill is resumable, locks with ingestion and retains IDs',async()=>{
  await send(1000,10);const stream=await Checkpoint.findOne({deviceId:device});await UsageBucket.deleteMany({deviceId:device});await Checkpoint.updateOne({_id:stream!._id},{$unset:{compactVersion:''}});
  await Promise.all([backfillStream({deviceId:device,seriesKey:stream!.seriesKey}),send(1400,20)]);await backfillStream({deviceId:device,seriesKey:stream!.seriesKey});expect((await verifyStorage()).total).toBe(1400);
 });
 test('shadow failure aborts the raw insert too, then retry counts exactly once',async()=>{
  await send(1000,10);const spy=jest.spyOn(UsageBucket,'updateOne').mockRejectedValueOnce(new Error('Injected shadow failure'));
  await expect(send(1400,20)).rejects.toThrow('Injected shadow failure');spy.mockRestore();expect(await UsageRecord.countDocuments()).toBe(1);expect((await verifyStorage()).total).toBe(1000);await send(1400,20);expect((await verifyStorage()).total).toBe(1400);
 });
 test('verification refuses incomplete or mismatching shadow',async()=>{await send(1000,10);await UsageBucket.deleteMany({});await expect(verifyStorage()).rejects.toThrow('parity failed');});
});
