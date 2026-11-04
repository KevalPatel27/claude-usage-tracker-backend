/** Versioned additive rollout. Raw records remain current for reversible reader cutover. */
import mongoose, { ClientSession, Schema, Types } from 'mongoose';
import { UsageRecord, Checkpoint, Device } from '../models/index.js';

export const storageMode = process.env.STORAGE_MODE ?? (process.env.NODE_ENV==='production'||process.env.RENDER==='true'?'mirror':'legacy');
if(!['legacy','mirror','compact-v2'].includes(storageMode))throw new Error('Invalid STORAGE_MODE');
if(storageMode==='compact-v2'&&(process.env.NODE_ENV==='production'||process.env.RENDER==='true'))throw new Error('Prototype compact-only mode is not allowed in production; use mirror rollout');
export const mirrorWrites=storageMode==='mirror';
export let compactStorage = storageMode==='compact-v2';
const journalEnabled=mirrorWrites||compactStorage;
export const STORAGE_VERSION='journals-v1';
export async function refreshReadMode(){
  if(!mirrorWrites)return;
  try{const control=await mongoose.connection.db!.collection('storageRollout').findOne({_id:STORAGE_VERSION as any});
    compactStorage=control?.readMode==='compact'&&control?.verifiedVersion===STORAGE_VERSION;
  }catch{compactStorage=false;}
}
export const MAX_POINTS = 256;
const Point = new Schema({
  i: { type: Schema.Types.ObjectId, required: true }, t: { type: String, required: true },
  s: { type: String, required: true }, r: { type: String, required: true },
  e: { type: Date, required: true }, c: { type: Date, required: true },
  v: { type: Number, required: true }, d: { type: Number, required: true },
  o: { type: Schema.Types.ObjectId, default: null },
}, { _id: false });
const BucketSchema = new Schema({
  deviceId: { type: Schema.Types.ObjectId, required: true }, seriesKey: { type: String, required: true },
  sessionId: { type: String, default: null }, usageModel: { type: String, required: true },
  tokenType: { type: String, required: true }, querySource: { type: String, required: true }, temporality: { type: Number, required: true },
  chunk: { type: Number, required: true }, p: { type: [Point], required: true, validate: (v: unknown[]) => v.length <= MAX_POINTS },
  minExportAt: Date, maxExportAt: Date,
}, { versionKey: false, collection: 'usagebuckets', autoCreate: journalEnabled, autoIndex: journalEnabled });
BucketSchema.index({ deviceId: 1, seriesKey: 1, chunk: 1 }, { unique: true });
BucketSchema.index({ deviceId: 1, seriesKey: 1, 'p.t': 1 });
BucketSchema.index({ 'p.e': -1 });
BucketSchema.index({ 'p.o': 1, 'p.e': -1 });
BucketSchema.index({ usageModel: 1, 'p.e': -1 });
BucketSchema.index({ deviceId: 1, sessionId: 1, 'p.e': -1 });
BucketSchema.index({ maxExportAt: 1, minExportAt: 1 }, { name: 'journal_period_bounds' });
export const UsageBucket = mongoose.model('UsageBucket', BucketSchema);
export const usageView = [
  { $unwind: '$p' },
  { $project: { _id: '$p.i', deviceId: 1, seriesKey: 1, sessionId: { $ifNull: ['$sessionId', null] },
    usageModel: 1, tokenType: 1, querySource: 1, temporality: 1,
    personIdAtTime: '$p.o', timeUnixNano: '$p.t', intervalStart: '$p.s', startTimeUnixNano: '$p.r',
    exportedAt: '$p.e', createdAt: '$p.c', cumulativeAtExport: '$p.v', deltaTokens: '$p.d' } },
];

/** Coarse indexed prefilter, followed by the ORIGINAL exact per-reading filter. */
function bucketMatch(match: Record<string, unknown> = {}) {
  const fields: Record<string,string> = { deviceId:'deviceId',seriesKey:'seriesKey',sessionId:'sessionId',usageModel:'usageModel',
    tokenType:'tokenType',querySource:'querySource',temporality:'temporality',personIdAtTime:'p.o',exportedAt:'p.e',timeUnixNano:'p.t',_id:'p.i' };
  const header: Record<string,unknown> = {}, point: Record<string,unknown> = {};
  for (const [key,value] of Object.entries(match)) {
    const field=fields[key];
    if (!field) continue;
    if (key==='exportedAt' && value && typeof value==='object' && !(value instanceof Date)) {
      const range=value as Record<string,unknown>;
      if (range.$gte!==undefined) header.maxExportAt={$gte:range.$gte};
      else if (range.$gt!==undefined) header.maxExportAt={$gt:range.$gt};
      if (range.$lt!==undefined) header.minExportAt={$lt:range.$lt};
      else if (range.$lte!==undefined) header.minExportAt={$lte:range.$lte};
      // Preserve exact matching below; other predicate shapes still use the array index.
      if (Object.keys(range).every(k=>['$gte','$gt','$lt','$lte'].includes(k))) continue;
    }
    if (field.startsWith('p.')) point[field.slice(2)]=value;
    else header[field]=value;
  }
  if (Object.keys(point).length) header.p={$elemMatch:point};
  return header;
}
/** Only compile known scalar predicates; the original exact $match always remains. */
function pointCondition(match: Record<string,unknown>) {
  const fields: Record<string,string>={personIdAtTime:'o',exportedAt:'e',timeUnixNano:'t',_id:'i'};
  const conditions: object[]=[];
  for (const [key,value] of Object.entries(match)) {
    if (!fields[key]) continue;
    const field='$$point.'+fields[key];
    if (value && typeof value==='object' && !(value instanceof Date) && !(value instanceof Types.ObjectId)) {
      for (const [op,v] of Object.entries(value)) {
        if (['$eq','$gt','$gte','$lt','$lte'].includes(op)) conditions.push({[op]:[field,{$literal:v}]});
      }
    } else if (value!==null) conditions.push({$eq:[field,{$literal:value}]});
  }
  return conditions.length ? {$and:conditions} : null;
}
export function compactPipeline(pipeline: any[]) {
  const match=pipeline[0]?.$match??{}, condition=pointCondition(match);
  return [{ $match: bucketMatch(match) },
    ...(condition?[{$set:{p:{$filter:{input:'$p',as:'point',cond:condition}}}}]:[]),
    ...usageView, ...pipeline];
}
export function usageAggregate(pipeline: any[]) {
  if (!compactStorage) return UsageRecord.aggregate(pipeline);
  return UsageBucket.aggregate(compactPipeline(pipeline));
}

/** One round trip for the three durable counter neighbors; no journal array sent to Node. */
export async function counterNeighbors(filter: {deviceId:Types.ObjectId;seriesKey:string}, time: string, session: ClientSession) {
  if (mirrorWrites || !compactStorage) {
    const same=await UsageRecord.findOne({...filter,timeUnixNano:time}).session(session);
    if(same)return {same,previous:null,next:null};
    const previous=await UsageRecord.findOne({...filter,timeUnixNano:{$lt:time}}).sort({timeUnixNano:-1}).session(session);
    const next=await UsageRecord.findOne({...filter,timeUnixNano:{$gt:time}}).sort({timeUnixNano:1}).session(session);
    return {same,previous,next};
  }
  const [result]=await UsageBucket.aggregate([
    {$match:filter},...usageView,
    {$facet:{same:[{$match:{timeUnixNano:time}},{$limit:1}],
      previous:[{$match:{timeUnixNano:{$lt:time}}},{$sort:{timeUnixNano:-1}},{$limit:1}],
      next:[{$match:{timeUnixNano:{$gt:time}}},{$sort:{timeUnixNano:1}},{$limit:1}]}}
  ]).session(session);
  return {same:result.same[0],previous:result.previous[0],next:result.next[0]};
}
export function findUsage(match: Record<string,unknown>, limit = 100001) {
  const sort = {exportedAt:1,timeUnixNano:1,deviceId:1,seriesKey:1,_id:1} as const;
  if (!compactStorage) return UsageRecord.find(match).sort(sort).limit(limit).lean();
  return usageAggregate([{$match:match},{$sort:sort},{$limit:limit}]).option({maxTimeMS:10000});
}

export function assertSandboxUri(uri: string) {
  const target = new URL(uri);
  if (target.protocol !== 'mongodb:' || !['127.0.0.1', 'localhost', '[::1]'].includes(target.hostname)
      || !/^\/(tracker_optimization|tracker_.*test_)[A-Za-z0-9_-]*$/.test(target.pathname)) {
    throw new Error('Optimization copy refuses non-loopback/non-sandbox database targets.');
  }
}
export async function initStorage() {
  if (!journalEnabled) return;
  await UsageBucket.init();
  const db = mongoose.connection.db!;
  const migration=await db.collection('_migrationState').findOne({_id:'compact-v2' as any});
  if(migration && migration.status!=='verified') throw new Error('Migration incomplete: reader startup refused; resume and verify the isolated restore first.');
  // Idempotent upgrade for earlier local journal prototypes; logical points are untouched.
  await UsageBucket.updateMany({$or:[{minExportAt:{$exists:false}},{maxExportAt:{$exists:false}}]},[
    {$set:{minExportAt:{$min:'$p.e'},maxExportAt:{$max:'$p.e'}}}
  ]);
  const existing = await db.listCollections({ name: 'usagepoints' }).toArray();
  if (existing.length && existing[0].type !== 'view') throw new Error('usagepoints must be a view; no data replaced.');
  if (!existing.length) await db.createCollection('usagepoints', { viewOn: 'usagebuckets', pipeline: usageView });
  else if(!('options' in existing[0])||JSON.stringify(existing[0].options?.pipeline)!==JSON.stringify(usageView))throw new Error('Unrecognized usagepoints view; refusing to replace it.');
  await refreshReadMode();
}

function header(row:any){return {deviceId:row.deviceId,seriesKey:row.seriesKey,sessionId:row.sessionId??null,
  usageModel:row.usageModel,tokenType:row.tokenType,querySource:row.querySource,temporality:row.temporality};}
function point(row:any){return {i:row._id,t:row.timeUnixNano,s:row.intervalStart,r:row.startTimeUnixNano,
  e:row.exportedAt,c:row.createdAt,v:row.cumulativeAtExport,d:row.deltaTokens,o:row.personIdAtTime??null};}

/** Same device lock/transaction as ingestion and purge; never overwrite concurrent new reports. */
export async function ensureMirrorStream(filter:{deviceId:Types.ObjectId;seriesKey:string},session:ClientSession,force=false){
  if(!mirrorWrites)return;
  const checkpoint=await Checkpoint.findOne(filter).session(session);
  if(!force && checkpoint?.compactVersion===STORAGE_VERSION)return;
  const rows=await UsageRecord.find(filter).sort({timeUnixNano:1,_id:1}).limit(100001).session(session).lean();
  if(rows.length>100000)throw new Error('Stream exceeds online backfill bound; coordinated migration required');
  // Rebuild is atomic and scoped. Marker written only after every bounded chunk succeeds.
  await UsageBucket.deleteMany(filter,{session});
  const chunks=[];
  for(let offset=0;offset<rows.length;offset+=MAX_POINTS){
    const selected=rows.slice(offset,offset+MAX_POINTS),h=header(selected[0]);
    if(selected.some(row=>JSON.stringify(header(row))!==JSON.stringify(h)))throw new Error('Inconsistent stream metadata');
    const dates=selected.map(row=>+row.exportedAt);
    chunks.push({...h,chunk:offset/MAX_POINTS,minExportAt:new Date(Math.min(...dates)),maxExportAt:new Date(Math.max(...dates)),p:selected.map(point)});
  }
  if(chunks.length)await UsageBucket.insertMany(chunks,{session,ordered:true});
  await Checkpoint.updateOne(filter,{$set:{compactVersion:STORAGE_VERSION}},{session,upsert:true});
}

export async function backfillStream(filter:{deviceId:Types.ObjectId;seriesKey:string},force=false){
  if(!mirrorWrites)throw new Error('Backfill requires mirror mode');
  const session=await mongoose.startSession();
  try{await session.withTransaction(async()=>{
    const device=await Device.findOneAndUpdate({_id:filter.deviceId},{$inc:{revision:1}},{session});
    if(!device)throw new Error('Orphaned usage stream requires review');
    await ensureMirrorStream(filter,session,force);
  },{readConcern:{level:'snapshot'},writeConcern:{w:'majority',j:true}});}finally{await session.endSession();}
}

export async function enrichSession(filter: object, sessionId: string, session: ClientSession) {
  if (mirrorWrites)await UsageRecord.updateMany({...filter,sessionId:null},{$set:{sessionId}},{session});
  if (journalEnabled) return UsageBucket.updateMany({ ...filter, sessionId: null }, { $set: { sessionId } }, { session });
  return UsageRecord.updateMany({ ...filter, sessionId: null }, { $set: { sessionId } }, { session });
}

/** Caller must already hold the device write lock in the SAME transaction. */
export async function appendUsage(row: any, session: ClientSession) {
  if (!journalEnabled) { await UsageRecord.create([row], { session }); return; }
  if(mirrorWrites){const [saved]=await UsageRecord.create([row],{session});row=saved.toObject();}
  const filter = { deviceId: row.deviceId, seriesKey: row.seriesKey };
  const tail = await UsageBucket.findOne(filter).sort({ chunk: -1 }).select('_id chunk').session(session).lean();
  const point = { i: row._id ?? new Types.ObjectId(), t: row.timeUnixNano, s: row.intervalStart, r: row.startTimeUnixNano,
    e: row.exportedAt, c: row.createdAt ?? new Date(), v: row.cumulativeAtExport, d: row.deltaTokens, o: row.personIdAtTime ?? null };
  if (tail) {
    const result = await UsageBucket.updateOne({ _id: tail._id, [`p.${MAX_POINTS - 1}`]: { $exists: false } }, { $push: { p: point },$min:{minExportAt:row.exportedAt},$max:{maxExportAt:row.exportedAt} }, { session });
    if (result.modifiedCount === 1) return;
  }
  await UsageBucket.create([{ ...filter, sessionId: row.sessionId ?? null, usageModel: row.usageModel, tokenType: row.tokenType,
      querySource: row.querySource, temporality: row.temporality, chunk: (tail?.chunk ?? -1) + 1, minExportAt:row.exportedAt,maxExportAt:row.exportedAt,p: [point] }], { session });
}

export async function correctDelta(filter: object, id: Types.ObjectId, deltaTokens: number, session: ClientSession) {
  if(mirrorWrites)await UsageRecord.updateOne({_id:id},{$set:{deltaTokens}},{session});
  if (journalEnabled){const result=await UsageBucket.updateOne({ ...filter, 'p.i': id }, { $set: { 'p.$[point].d': deltaTokens } }, { arrayFilters: [{ 'point.i': id }], session });
    if(result.matchedCount!==1)throw new Error('Missing shadow successor; transaction aborted');return result;}
  return UsageRecord.updateOne({ _id: id }, { $set: { deltaTokens } }, { session });
}

export async function deleteUsage(filter: { deviceId?: Types.ObjectId; personIdAtTime?: Types.ObjectId }, session: ClientSession) {
  // Even a legacy rollback must honor deletion in an existing shadow collection.
  if(storageMode!=='compact-v2')await UsageRecord.deleteMany(filter,{session});
  if (filter.deviceId) return UsageBucket.deleteMany({ deviceId: filter.deviceId }, { session });
  if (filter.personIdAtTime) {
    await UsageBucket.updateMany({ 'p.o': filter.personIdAtTime }, { $pull: { p: { o: filter.personIdAtTime } } }, { session });
    return UsageBucket.deleteMany({ p: { $size: 0 } }, { session });
  }
  throw new Error('Refusing unscoped journal deletion.');
}

export async function storageStats() {
  const logical = await UsageRecord.countDocuments();
  const physical = journalEnabled ? await UsageBucket.countDocuments() : logical;
  const [logicalSize]=await UsageRecord.aggregate([{$group:{_id:null,n:{$sum:{$bsonSize:'$$ROOT'}}}}]);
  const [physicalSize]=journalEnabled?await UsageBucket.aggregate([{$group:{_id:null,n:{$sum:{$bsonSize:'$$ROOT'}}}}]):[logicalSize];
  return { logicalBsonBytes:logicalSize?.n??0,physicalBsonBytes:physicalSize?.n??0,mode:storageMode,readMode:compactStorage?'compact':'raw',writerVersion:STORAGE_VERSION,logicalReadings: logical, physicalDocuments: physical,
    maxPointsPerDocument: journalEnabled ? MAX_POINTS : 1, prototype:storageMode==='compact-v2',rawRetained:mirrorWrites,
    note:mirrorWrites?'Raw and compact records are retained and updated transactionally during rollout. No raw storage reclaimed.':'All logical readings, timestamps and zero increments retained.' };
}
