import { usageAggregate, findUsage } from '../lib/storage.js';
import { storageStats } from '../lib/storage.js';
import { PromptTurn } from '../models/history.js';
import { historyRetentionDays } from '../lib/history.js';
import { Router } from 'express';
import { Types } from 'mongoose';
import { Device, Person, UsageRecord } from '../models/index.js';
import { requireAdmin } from '../middleware/auth.js';
import { route } from '../lib/route.js';
import { usageQuery, csvCell } from '../lib/query.js';
import { readPricing, estimateCost, pricingMetadata } from '../lib/pricing.js';
export const dashboardRouter = Router();
dashboardRouter.use(requireAdmin);
dashboardRouter.get('/storage-status',route(async(_req,res)=>res.json(await storageStats())));

// Session identity is scoped by device. Missing historical IDs are explicit buckets, not invented sessions.
dashboardRouter.get('/sessions', route(async(req,res)=>{
  const q=usageQuery(req.query), rawPage=req.query.page??'0';
  if(typeof rawPage!=='string'||!/^(0|[1-9]\d{0,4})$/.test(rawPage))return res.status(400).json({error:'Invalid session page'});
  const page=Number(rawPage),limit=25;
  const [data]=await usageAggregate([
    {$match:q.match},
    {$group:{_id:{deviceId:'$deviceId',sessionId:{$ifNull:['$sessionId',null]},model:'$usageModel',tokenType:'$tokenType',personId:'$personIdAtTime'},tokens:{$sum:'$deltaTokens'},records:{$sum:1},firstReportAt:{$min:'$exportedAt'},lastReportAt:{$max:'$exportedAt'}}},
    {$group:{_id:{deviceId:'$_id.deviceId',sessionId:'$_id.sessionId'},totalTokens:{$sum:'$tokens'},recordCount:{$sum:'$records'},firstReportAt:{$min:'$firstReportAt'},lastReportAt:{$max:'$lastReportAt'},personIds:{$addToSet:'$_id.personId'},breakdown:{$push:{_id:{model:'$_id.model',tokenType:'$_id.tokenType'},totalTokens:'$tokens'}}}},
    {$sort:{lastReportAt:-1,'_id.deviceId':1,'_id.sessionId':1}},
    { $facet: {
      rows: [{ $skip: page * limit }, { $limit: limit + 1 }],
      counts: [{ $group: {
        _id: null, totalGroups: { $sum: 1 },
        knownSessionCount: { $sum: { $cond: [{ $ne: ['$_id.sessionId', null] }, 1, 0] } },
        unattributedTokens: { $sum: { $cond: [{ $eq: ['$_id.sessionId', null] }, '$totalTokens', 0] } },
      } }],
    } },
  ]).option({maxTimeMS:10000});
  const [people,devices]=await Promise.all([Person.find({_id:{$in:data.rows.flatMap((r:{personIds:unknown[]})=>r.personIds)}}).select('name').lean(),Device.find({_id:{$in:data.rows.map((r:{_id:{deviceId:Types.ObjectId}})=>r._id.deviceId)}}).select('name').lean()]);
  const names=new Map(people.map(p=>[String(p._id),p.name])),deviceNames=new Map(devices.map(d=>[String(d._id),d.name])),pricing=readPricing();
  const rows=data.rows.slice(0,limit).map((row:{_id:{deviceId:Types.ObjectId;sessionId:string|null};personIds:Array<Types.ObjectId|null>;breakdown:Parameters<typeof estimateCost>[0];totalTokens:number;recordCount:number;firstReportAt:Date;lastReportAt:Date})=>({
    deviceId:row._id.deviceId,deviceName:deviceNames.get(String(row._id.deviceId))??'Unknown device',sessionId:row._id.sessionId,
    people:row.personIds.map(id=>({id,name:id?names.get(String(id))??'Unknown person':'Unassigned'})),
    totalTokens:row.totalTokens,recordCount:row.recordCount,firstReportAt:row.firstReportAt,lastReportAt:row.lastReportAt,
    models:[...new Set(row.breakdown.map(r=>r._id.model))].sort(),
    tokenBreakdown:Object.fromEntries(['input','output','cacheRead','cacheCreation'].map(type=>[type,row.breakdown.filter(r=>r._id.tokenType===type).reduce((n,r)=>n+r.totalTokens,0)])),
    estimatedCostUsd:estimateCost(row.breakdown,pricing.rates).amount,
  }));
  res.setHeader('Cache-Control','no-store');
  return res.json({rows,page,hasMore:data.rows.length>limit,...(data.counts[0]??{totalGroups:0,knownSessionCount:0,unattributedTokens:0}),period:{from:q.from,to:q.to,timezone:q.timezone},generatedAt:new Date()});
}));
dashboardRouter.get('/overview', route(async (req,res) => {
  const q = usageQuery(req.query);
  const trendUnit = q.to.getTime() - q.from.getTime() <= 2 * 86400000 ? 'hour' : 'day';
  // One aggregation command gives a consistent snapshot for every displayed breakdown.
  const [data] = await usageAggregate([{ $match: q.match }, { $facet: {
    totalsByType: [{ $group: { _id:'$tokenType',total:{$sum:'$deltaTokens'} } }],
    byPerson: [{ $group:{ _id:'$personIdAtTime',totalTokens:{$sum:'$deltaTokens'} } },{$sort:{totalTokens:-1}}],
    byDevice: [{ $group:{ _id:'$deviceId',totalTokens:{$sum:'$deltaTokens'} } },{$sort:{totalTokens:-1}}],
    byModel: [{ $group:{ _id:{ model:'$usageModel',tokenType:'$tokenType' },totalTokens:{$sum:'$deltaTokens'} } }],
    dailyTrend: [{ $group:{ _id:{ $dateToString:{format:'%Y-%m-%d',date:'$exportedAt',timezone:q.timezone} },totalTokens:{$sum:'$deltaTokens'} } },{$sort:{_id:1}}],
    trendByType: [{ $group: { _id: { at: { $dateTrunc: { date: '$exportedAt', unit: trendUnit, timezone: q.timezone } }, model: '$usageModel', tokenType: '$tokenType' }, totalTokens: { $sum: '$deltaTokens' } } }, { $sort: { '_id.at': 1 } }],
    count: [{$count:'value'}]
  } }]).option({ maxTimeMS: 10000 });
  const [people,devices] = await Promise.all([Person.find().select('name').lean(),Device.find().select('name lastReportAt revokedAt').lean()]);
  const names = new Map(people.map(p=>[p._id.toString(),p.name]));
  const deviceNames = new Map(devices.map(d=>[d._id.toString(),d.name]));
  const lastReportAt = devices.reduce<Date|null>((latest,d)=>d.lastReportAt && (!latest || d.lastReportAt>latest) ? d.lastReportAt : latest,null);
  const pricing = readPricing();
  const cost = estimateCost(data.byModel, pricing.rates);
  const buckets = new Map<string, { at: string; totalTokens: number; input: number; output: number; cacheRead: number; cacheCreation: number; rows: Parameters<typeof estimateCost>[0] }>();
  for (const row of data.trendByType) {
    const at = row._id.at.toISOString();
    const bucket = buckets.get(at) ?? { at, totalTokens: 0, input: 0, output: 0, cacheRead: 0, cacheCreation: 0, rows: [] as Parameters<typeof estimateCost>[0] };
    bucket.totalTokens += row.totalTokens;
    const tokenType = row._id.tokenType as 'input'|'output'|'cacheRead'|'cacheCreation';
    bucket[tokenType] += row.totalTokens;
    bucket.rows.push({ _id: { model: row._id.model, tokenType }, totalTokens: row.totalTokens });
    buckets.set(at, bucket);
  }
  const trend = [...buckets.values()].map(({ rows, ...bucket }) => ({ ...bucket, estimatedCostUsd: estimateCost(rows, pricing.rates).amount }));
  const costByModel = [...new Set<string>(data.byModel.map((r: { _id: { model: string } }) => r._id.model))].sort().map(model => ({ model,
    estimatedCostUsd: estimateCost(data.byModel.filter((r: { _id: { model: string } }) => r._id.model === model), pricing.rates).amount }));
  res.setHeader('Cache-Control','no-store');
  const { trendByType: _trendByType, ...overview } = data;
  return res.json({ ...overview, trend, trendGranularity: trendUnit, dataMode:process.env.DATA_MODE??'collected', period:{from:q.from,to:q.to,timezone:q.timezone}, recordCount:data.count[0]?.value??0,
    byPerson:data.byPerson.map((p: {_id: Types.ObjectId|null})=>({...p,personId:p._id,personName:names.get(String(p._id))??'Unassigned'})),
    byDevice:data.byDevice.map((d: {_id: Types.ObjectId})=>({...d,deviceName:deviceNames.get(String(d._id))??'Unknown device'})),
    deviceCount:devices.filter(d=>!d.revokedAt).length,lastReportAt,generatedAt:new Date(),
    estimatedCostUsd: cost.amount, costByModel, pricing: { ...pricingMetadata(pricing), unpricedModels: cost.unpricedModels, configurationError: pricing.error },
    costNote:'Current configured standard API rates, not subscription billing. Cache-write and speed assumptions apply; unknown models are not priced.',
    note:'Increments are assigned to export time. Late reports can revise earlier buckets. Missing reports are not confirmed zero usage.' });
}));
dashboardRouter.get('/export.csv', route(async (req,res) => {
  const q=usageQuery(req.query);
  const records=await findUsage(q.match);
  if(records.length>100000) return res.status(413).json({error:'Export exceeds 100,000 records; choose a smaller date range'});
  const pricing = readPricing();
  const header=['exportedAtUtc','reportingDate','timezone','personId','deviceId','sessionId','model','tokenType','querySource','estimatedApiCostUsd','deltaTokens'];
  const format=new Intl.DateTimeFormat('en-CA',{timeZone:q.timezone,year:'numeric',month:'2-digit',day:'2-digit'});
  const lines=records.map(r=>[r.exportedAt.toISOString(),format.format(r.exportedAt),q.timezone,r.personIdAtTime,r.deviceId,r.sessionId,r.usageModel,r.tokenType,r.querySource,estimateCost([{_id:{model:r.usageModel,tokenType:r.tokenType},totalTokens:r.deltaTokens}],pricing.rates).amount,r.deltaTokens].map(csvCell).join(','));
  res.setHeader('Cache-Control','no-store');res.type('text/csv');res.setHeader('Content-Disposition','attachment; filename="usage.csv"');
  return res.send([header.join(','),...lines].join('\r\n'));
}));
dashboardRouter.get('/collection-status', route(async (_req,res)=>{
  const devices=await Device.find().populate('personId','name').sort({lastReportAt:-1}).lean();
  return res.json({devices:devices.map(d=>({deviceId:d._id,deviceName:d.name,personName:(d.personId as unknown as {name?:string})?.name??null,
    lastReportAt:d.lastReportAt,status:d.revokedAt?'revoked':!d.lastReportAt?'never':Date.now()-d.lastReportAt.getTime()>4*3600000?'stale':'recent',keyPrefix:d.keyPrefix})),generatedAt:new Date()});
}));
dashboardRouter.get('/verify-device/:deviceId', route(async(req,res)=>{
  if(!Types.ObjectId.isValid(req.params.deviceId)) return res.status(400).json({error:'Invalid device ID'});
  const device=await Device.findById(req.params.deviceId).lean();
  if(!device) return res.status(404).json({error:'Device not found'});
  const since=new Date(String(req.query.since??new Date(Date.now()-3600000).toISOString()));
  if(!Number.isFinite(since.getTime())) return res.status(400).json({error:'Invalid verification time'});
  const recentReport=await UsageRecord.findOne({deviceId:device._id,createdAt:{$gte:since},deltaTokens:{$gt:0}}).sort({createdAt:-1}).lean();
  if(req.query.history!==undefined && !['true','false'].includes(String(req.query.history))) return res.status(400).json({error:'Invalid history verification option'});
  const historyVerified = req.query.history==='true' ? !!(device.promptCollectionEnabled && await PromptTurn.exists({deviceId:device._id,createdAt:{$gte:since},submittedAt:{$gte:since},expiresAt:{$gt:new Date()}})) : null;
  return res.json({deviceId:device._id,deviceName:device.name,lastReportAt:device.lastReportAt,historyVerified,
    hasReported:!!device.lastReportAt,verified:!device.revokedAt && !device.archivedAt && !!recentReport && historyVerified!==false,recentReport:recentReport?{exportedAt:recentReport.exportedAt,model:recentReport.usageModel,tokenType:recentReport.tokenType,deltaTokens:recentReport.deltaTokens}:null});
}));
dashboardRouter.get('/settings',route(async(_req,res)=>res.json({dataMode:process.env.DATA_MODE??'collected',reportingTimezone:process.env.REPORTING_TIMEZONE??'UTC',
  promptRetentionDays:historyRetentionDays(),dataRetentionDays:null,retentionNote:'Automatic deletion is disabled. Keep counter and deduplication state with usage records until a coordinated archival policy is implemented.',version:'1.0.0'})));
