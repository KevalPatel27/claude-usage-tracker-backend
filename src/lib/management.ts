import { PromptTurn } from '../models/history.js';
import mongoose, { ClientSession, Types } from 'mongoose';
import { Device, Person, UsageRecord, Checkpoint } from '../models/index.js';

export class ManagementError extends Error {
  constructor(public status: number, message: string) { super(message); }
}
export const fail = (status: number, message: string): never => { throw new ManagementError(status, message); };
export const safeDevice = (value: Record<string, unknown>) => {
  const { keyHash, ...safe } = value;
  return safe;
};
export async function transaction<T>(work: (session: ClientSession) => Promise<T>): Promise<T> {
  const session = await mongoose.startSession();
  try { return (await session.withTransaction(() => work(session), { readConcern: { level: 'snapshot' }, writeConcern: { w: 'majority', j: true } }))!; }
  finally { await session.endSession(); }
}
export async function lockPerson(id: string, session: ClientSession, active = false) {
  const person = await Person.findOneAndUpdate({ _id: id }, { $inc: { revision: 1 } }, { new: true, session });
  if (!person) return fail(404, 'Person not found');
  if (active && person.archivedAt) return fail(409, 'Restore this person before assigning a device.');
  return person;
}
export async function lockDevice(id: string, session: ClientSession) {
  const device = await Device.findOneAndUpdate({ _id: id }, { $inc: { revision: 1 } }, { new: true, session });
  if (!device) return fail(404, 'Device not found');
  return device;
}
export async function deletionReason(kind: 'person' | 'device', id: Types.ObjectId, session?: ClientSession) {
  const options = session ? { session } : {};
  if (kind === 'person') {
    if (await Device.exists({ $or: [{ personId: id }, { 'assignments.personId': id }] }).setOptions(options)) return 'A current or historical device assignment exists. Archive this person to preserve attribution.';
    if (await PromptTurn.exists({personIdAtTime:id}).setOptions(options)) return 'Recorded prompt history exists. Archive this person to preserve attribution.';
    if (await UsageRecord.exists({ personIdAtTime: id }).setOptions(options)) return 'Recorded usage exists. Archive this person to preserve history.';
  } else {
    const device = await Device.findById(id).setOptions(options);
    if (await PromptTurn.exists({deviceId:id}).setOptions(options)) return 'This device has prompt history. Use permanent deletion to erase it.';
    if (device?.lastReportAt || await UsageRecord.exists({ deviceId: id }).setOptions(options) || await Checkpoint.exists({ deviceId: id }).setOptions(options)) return 'This device has reported. Archive it to preserve usage and counter history.';
    if (device && !device.revokedAt) return 'Revoke or archive this device before deleting it.';
  }
  return null;
}
