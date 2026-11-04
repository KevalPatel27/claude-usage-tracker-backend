import { deleteUsage } from './storage.js';
import { PromptTurn, PromptErasure, SessionProject } from '../models/history.js';
import { erasePromptRows } from './history.js';
import { ClientSession } from 'mongoose';
import { Checkpoint, Device, Person, UsageRecord } from '../models/index.js';
import { fail, lockDevice, lockPerson } from './management.js';

function confirmName(expected:string, supplied:unknown) {
 if(typeof supplied!=='string'||supplied!==expected)fail(409,'Enter the exact current name to permanently delete this record and its usage.');
}
export async function purgeDevice(id:string, confirmation:unknown, session:ClientSession) {
 const device=await lockDevice(id,session);confirmName(device.name,confirmation);
 // Device lock serializes with in-flight ingestion. Removing its key prevents future retries.
 await deleteUsage({deviceId:device._id},session);
 await Checkpoint.deleteMany({deviceId:device._id},{session});
 await PromptTurn.deleteMany({deviceId:device._id},{session});
 await PromptErasure.deleteMany({deviceId:device._id},{session});
 await SessionProject.deleteMany({deviceId:device._id},{session});
 await device.deleteOne({session});
}
export async function purgePerson(id:string, confirmation:unknown, session:ClientSession) {
 const person=await lockPerson(id,session);confirmName(person.name,confirmation);
 const usageDevices=await UsageRecord.distinct('deviceId',{personIdAtTime:person._id}).session(session);
 const historyDevices=await PromptTurn.distinct('deviceId',{personIdAtTime:person._id}).session(session);
 const devices=await Device.find({$or:[{personId:person._id},{'assignments.personId':person._id},{_id:{$in:[...usageDevices,...historyDevices]}}]}).sort({_id:1}).session(session);
 for(const snapshot of devices){
  const device=await lockDevice(String(snapshot._id),session);
  const prompts=await PromptTurn.find({deviceId:device._id,personIdAtTime:person._id}).select('deviceId sessionId promptId').session(session);
  await erasePromptRows(prompts,session);
  // Remove only the target person's usage. Other owners' records and totals remain intact.
  const series=await UsageRecord.distinct('seriesKey',{deviceId:device._id,personIdAtTime:person._id}).session(session);
  for(const seriesKey of series){
   const filter={deviceId:device._id,seriesKey};
   const latest=await UsageRecord.findOne(filter).sort({timeUnixNano:-1}).session(session);
   const checkpoint=await Checkpoint.findOne(filter).session(session);
   if(latest&&(!checkpoint?.purgedThroughTimeUnixNano||latest.timeUnixNano>checkpoint.purgedThroughTimeUnixNano)){
    // Opaque accounting floor, without person attribution. Deleted samples must never replay.
    await Checkpoint.updateOne(filter,{$set:{purgedThroughTimeUnixNano:latest.timeUnixNano,purgedCumulative:latest.cumulativeAtExport}},{session,upsert:true});
   }
  }
  if(String(device.personId)===String(person._id)){
   device.personId=null;
   device.revokedAt=device.revokedAt??new Date();
  }
  device.assignments=device.assignments.filter(a=>String(a.personId)!==String(person._id));
  await device.save({session});
 }
 await deleteUsage({personIdAtTime:person._id},session);
 await Person.deleteOne({_id:person._id},{session});
}
