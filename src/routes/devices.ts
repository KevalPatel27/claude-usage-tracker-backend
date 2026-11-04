import { purgeDevice } from '../lib/purge.js';
import { transaction, lockPerson, lockDevice, deletionReason, fail, safeDevice } from '../lib/management.js';
import { usageQuery, csvCell } from '../lib/query.js';
import { route } from '../lib/route.js';
/**
 * Device management routes.
 * All routes require admin authentication.
 * Device keys are generated here and shown ONCE; only hashes are stored.
 */

import { Router, Request, Response } from 'express';
import { Types } from 'mongoose';
import { Device, Person, UsageRecord } from '../models/index.js';
import { generateDeviceKey } from '../lib/crypto.js';
import { requireAdmin } from '../middleware/auth.js';

export const devicesRouter = Router();
devicesRouter.use(requireAdmin);
devicesRouter.param('id', (req,res,next,id) => { if(!/^[0-9a-f]{24}$/i.test(id)) return res.status(400).json({error:'Invalid ID'}); next(); });

// List all devices
devicesRouter.get('/', route(async (req: Request, res: Response) => {
  const devices = await Device.find(req.query.includeArchived === 'true' ? {} : { archivedAt: null }).populate('personId', 'name').sort({ createdAt: -1 }).lean();
  return res.json(devices.map(safeDevice));
}));

// Get single device
devicesRouter.get('/:id', route(async (req: Request, res: Response) => {
  const device = await Device.findById(req.params.id).populate('personId', 'name').populate('assignments.personId', 'name').lean();
  if (!device) return res.status(404).json({ error: 'Device not found' });
  return res.json({...safeDevice(device),deleteReason:await deletionReason('device',device._id)});
}));

// Register a new device and generate its key
devicesRouter.post('/', route(async (req: Request, res: Response) => {
  const { name, personId, promptCollectionEnabled = false } = req.body;
  if(typeof promptCollectionEnabled!=='boolean') return res.status(400).json({error:'Invalid prompt history preference'});
  if (typeof name !== 'string' || !name.trim() || name.length > 120) return res.status(400).json({ error: 'Device name required' });

  if (personId !== undefined && personId !== null && (typeof personId !== 'string' || !/^[a-f0-9]{24}$/i.test(personId))) {
    return res.status(400).json({ error: 'Invalid personId' });
  }

  const { rawKey, keyHash, keyPrefix } = generateDeviceKey();
  const device = await transaction(async session => {
    const person = personId ? await lockPerson(personId,session,true) : null;
    const [created] = await Device.create([{name:name.trim(),keyHash,keyPrefix,promptCollectionEnabled,personId:person?._id??null,assignments:person?[{personId:person._id,assignedAt:new Date()}]:[]}],{session});
    return created;
  });

  // Return raw key once — never stored
  return res.status(201).json({
    device: safeDevice(device.toObject()),
    rawKey, // shown once for setup
    warning: 'Copy this key now. It will not be shown again.',
  });
}));

// Rename a device
devicesRouter.patch('/:id/name', route(async (req: Request, res: Response) => {
  const { name } = req.body;
  if (typeof name !== 'string' || !name.trim() || name.length > 120) return res.status(400).json({ error: 'Name required' });
  const device = await Device.findByIdAndUpdate(
    req.params.id,
    { name: name.trim() },
    { new: true }
  ).lean();
  if (!device) return res.status(404).json({ error: 'Device not found' });
  return res.json(safeDevice(device));
}));

// Edit a device profile.
devicesRouter.patch('/:id', route(async (req,res) => {
  const {name,notes} = req.body;
  if(typeof name!=='string'||!name.trim()||name.length>120||(notes!==undefined&&(typeof notes!=='string'||notes.length>2000))) return res.status(400).json({error:'Provide a name (1–120 characters) and notes up to 2,000 characters.'});
  const d=await Device.findByIdAndUpdate(req.params.id,{$set:{name:name.trim(),...(notes!==undefined?{notes:notes.trim()}:{})}},{new:true,runValidators:true}).lean();
  if(!d)return res.status(404).json({error:'Device not found'});return res.json(safeDevice(d));
}));
devicesRouter.patch('/:id/prompt-history', route(async(req,res)=>{
  if(typeof req.body?.enabled!=='boolean')return res.status(400).json({error:'Provide enabled as true or false.'});
  const device=await transaction(async session=>{const d=await lockDevice(req.params.id,session);d.promptCollectionEnabled=req.body.enabled;await d.save({session});return d;});
  return res.json(safeDevice(device.toObject()));
}));
// Assignment changes serialize with ingestion; stored usage retains its original person.
devicesRouter.patch('/:id/assign', route(async (req,res) => {
  const {personId} = req.body;
  if(personId!==null && (typeof personId!=='string'||!/^[a-f0-9]{24}$/i.test(personId))) return res.status(400).json({error:'Valid personId or null required'});
  const device = await transaction(async session => {
    // Lock the target person before device, matching create/reactivate lock order.
    const person=personId?await lockPerson(personId,session,true):null;
    const d=await lockDevice(req.params.id,session);
    if(d.archivedAt)fail(409,'Restore this device before changing its assignment.');
    if(String(d.personId??'')===String(person?._id??''))return d;
    const last=d.assignments[d.assignments.length-1];if(last&&!last.revokedAt)last.revokedAt=new Date();
    if(person)d.assignments.push({personId:person._id,assignedAt:new Date()});
    d.personId=person?._id??null;await d.save({session});return d;
  });return res.json({device:safeDevice(device.toObject())});
}));
for(const action of ['rotate-key','reactivate','revoke','archive','restore'] as const){
  devicesRouter.post('/:id/'+action,route(async(req,res)=>{
    const fresh=(action==='rotate-key'||action==='reactivate')?generateDeviceKey():null;
    const device=await transaction(async session=>{
      // Reactivation may enable reporting for an archived person: lock and re-check assignment.
      const snapshot=await Device.findById(req.params.id).session(session);
      if(!snapshot) return fail(404,'Device not found');
      if(action==='reactivate'&&snapshot.personId)await lockPerson(String(snapshot.personId),session,true);
      const d=await lockDevice(req.params.id,session);
      if(action==='rotate-key'&&(d.revokedAt||d.archivedAt))fail(409,'Reactivate the revoked device to generate a new key.');
      if(action==='reactivate'&&d.archivedAt)fail(409,'Restore this device before reactivating reporting.');
      if(action==='reactivate'&&!d.revokedAt)fail(409,'Device is already active. Rotate its key instead.');
      if(fresh){d.keyHash=fresh.keyHash;d.keyPrefix=fresh.keyPrefix;if(action==='reactivate')d.revokedAt=null;}
      if(action==='archive'){d.archivedAt=d.archivedAt??new Date();d.revokedAt=d.revokedAt??new Date();}
      if(action==='restore')d.archivedAt=null; // Never re-enable the previous key.
      if(action==='revoke')d.revokedAt=d.revokedAt??new Date();
      await d.save({session});return d;
    });return res.json({device:safeDevice(device.toObject()),...(fresh?{rawKey:fresh.rawKey,warning:'Apply this new key on the PC and restart Claude Desktop.'}:{})});
  }));
}
devicesRouter.delete('/:id',route(async(req,res)=>{
  await transaction(async session=>{if(req.query.purge==='true'){await purgeDevice(req.params.id,req.body?.confirmation,session);return;}const d=await lockDevice(req.params.id,session);const reason=await deletionReason('device',d._id,session);if(reason)fail(409,reason);await d.deleteOne({session});});return res.status(204).end();
}));

// Detail summary and export use shared dashboard filters.
devicesRouter.get('/:id/usage', route(async(req,res)=>{
  const q=usageQuery({...req.query, deviceId:req.params.id});
  const records=await UsageRecord.aggregate([{$match:q.match},{$group:{_id:{usageModel:'$usageModel',tokenType:'$tokenType',deviceId:'$deviceId'},totalTokens:{$sum:'$deltaTokens'}}}]);
  const person=null;
  return res.json({records,person});
}));
devicesRouter.get('/:id/export.csv', route(async(req,res)=>{
  const q=usageQuery({...req.query, deviceId:req.params.id});
  const records=await UsageRecord.find(q.match).sort({exportedAt:1}).limit(100001).lean();
  if(records.length>100000) return res.status(413).json({error:'Choose a smaller date range'});
  res.type('text/csv');res.setHeader('Content-Disposition','attachment; filename="usage.csv"');res.setHeader('Cache-Control','no-store');
  return res.send(['exportedAt,personId,deviceId,sessionId,model,tokenType,querySource,deltaTokens',...records.map(r=>[r.exportedAt.toISOString(),r.personIdAtTime,r.deviceId,r.sessionId,r.usageModel,r.tokenType,r.querySource,r.deltaTokens].map(csvCell).join(','))].join('\r\n'));
}));
