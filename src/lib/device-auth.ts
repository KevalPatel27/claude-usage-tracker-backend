import { Device } from '../models/index.js';
import { verifyDeviceKey } from './crypto.js';

export async function authenticateDeviceKey(value: unknown) {
  if (typeof value !== 'string' || !/^dkey_[a-f0-9]{64}$/.test(value)) return null;
  const candidates = await Device.find({ revokedAt: null, archivedAt: null, keyPrefix: value.slice(5, 13) }).lean();
  for (const candidate of candidates) if (await verifyDeviceKey(value, candidate.keyHash)) return candidate;
  return null;
}
