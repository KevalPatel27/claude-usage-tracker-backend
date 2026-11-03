import { purgePerson } from '../lib/purge.js';
import { transaction, lockPerson, deletionReason, fail, safeDevice } from '../lib/management.js';

import { usageQuery, csvCell } from '../lib/query.js';

import { route } from '../lib/route.js';

/**

 * People management routes.

 */



import { Router, Request, Response } from 'express';

import { Person, Device, UsageRecord } from '../models/index.js';

import { requireAdmin } from '../middleware/auth.js';

import { Types } from 'mongoose';



export const peopleRouter = Router();

peopleRouter.use(requireAdmin);

peopleRouter.param('id', (req,res,next,id) => { if(!/^[0-9a-f]{24}$/i.test(id)) return res.status(400).json({error:'Invalid ID'}); next(); });



// List all people with their devices

peopleRouter.get('/', route(async (req: Request, res: Response) => {

  const people = await Person.find(req.query.includeArchived === "true" ? {} : { archivedAt: null }).sort({ name: 1 }).lean();

  const devices = await Device.find().lean();



  const result = people.map(p => ({

    ...p,

    devices: devices

      .filter(d => d.personId?.toHexString() === p._id.toHexString())

      .map(d => ({

        _id: d._id,

        name: d.name,

        keyPrefix: d.keyPrefix,

        lastReportAt: d.lastReportAt,

        revokedAt: d.revokedAt,

        archivedAt: d.archivedAt,

      })),

  }));



  return res.json(result);

}));



// Create person

peopleRouter.post('/', route(async (req: Request, res: Response) => {

  const { name } = req.body;

  if (typeof name !== 'string' || !name.trim() || name.length > 120) return res.status(400).json({ error: 'Name required' });

  const person = await Person.create({ name: name.trim() });

  return res.status(201).json(person);

}));



// Profile reads and lifecycle actions preserve historical usage.

peopleRouter.get('/:id', route(async (req,res) => {

  const person = await Person.findById(req.params.id).lean();

  if (!person) return res.status(404).json({error:'Person not found'});

  const devices = await Device.find({personId:person._id}).lean();

  const deleteReason = await deletionReason('person',person._id);

  return res.json({...person, devices:devices.map(safeDevice), deleteReason});

}));

peopleRouter.patch('/:id', route(async (req,res) => {

  const {name,notes} = req.body;

  if (typeof name !== 'string' || !name.trim() || name.length>120 || (notes!==undefined && (typeof notes!=='string'||notes.length>2000))) return res.status(400).json({error:'Provide a name (1–120 characters) and notes up to 2,000 characters.'});

  const person = await Person.findByIdAndUpdate(req.params.id,{$set:{name:name.trim(),...(notes!==undefined?{notes:notes.trim()}:{})}},{new:true,runValidators:true});

  if (!person) return res.status(404).json({error:'Person not found'});

  return res.json(person);

}));

peopleRouter.post('/:id/archive', route(async (req,res) => {

  const person = await transaction(async session => {

    const p = await lockPerson(req.params.id,session);

    if (await Device.exists({personId:p._id,revokedAt:null,archivedAt:null}).session(session)) fail(409,'Reassign, revoke or archive active devices before archiving this person.');

    p.archivedAt = p.archivedAt ?? new Date(); await p.save({session}); return p;

  }); return res.json(person);

}));

peopleRouter.post('/:id/restore', route(async (req,res) => {

  const person = await transaction(async session => {const p=await lockPerson(req.params.id,session);p.archivedAt=null;await p.save({session});return p;});

  return res.json(person);

}));

peopleRouter.delete('/:id', route(async (req,res) => {

  await transaction(async session => {if(req.query.purge==='true'){await purgePerson(req.params.id,req.body?.confirmation,session);return;}const p=await lockPerson(req.params.id,session);const reason=await deletionReason('person',p._id,session);if(reason)fail(409,reason);await p.deleteOne({session});});

  return res.status(204).end();

}));



// Detail summary and export use shared dashboard filters.

peopleRouter.get('/:id/usage', route(async(req,res)=>{

  const q=usageQuery({...req.query, personId:req.params.id});

  const records=await UsageRecord.aggregate([{$match:q.match},{$group:{_id:{usageModel:'$usageModel',tokenType:'$tokenType',deviceId:'$deviceId'},totalTokens:{$sum:'$deltaTokens'}}}]);

  const person=await Person.findById(req.params.id).lean();

  return res.json({records,person});

}));

peopleRouter.get('/:id/export.csv', route(async(req,res)=>{

  const q=usageQuery({...req.query, personId:req.params.id});

  const records=await UsageRecord.find(q.match).sort({exportedAt:1}).limit(100001).lean();

  if(records.length>100000) return res.status(413).json({error:'Choose a smaller date range'});

  res.type('text/csv');res.setHeader('Content-Disposition','attachment; filename="usage.csv"');res.setHeader('Cache-Control','no-store');

  return res.send(['exportedAt,personId,deviceId,sessionId,model,tokenType,querySource,deltaTokens',...records.map(r=>[r.exportedAt.toISOString(),r.personIdAtTime,r.deviceId,r.sessionId,r.usageModel,r.tokenType,r.querySource,r.deltaTokens].map(csvCell).join(','))].join('\r\n'));

}));
