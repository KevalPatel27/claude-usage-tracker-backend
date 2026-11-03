import crypto from 'crypto';
import bcrypt from 'bcrypt';

const KEY_PREFIX = 'dkey_';
const BCRYPT_ROUNDS = 12;

/**
 * Generate a new cryptographically random device key.
 * Returns both the raw key (show once, never store) and its bcrypt hash.
 */
export function generateDeviceKey(): { rawKey: string; keyHash: string; keyPrefix: string } {
  const rawBytes = crypto.randomBytes(32).toString('hex');
  const rawKey = `${KEY_PREFIX}${rawBytes}`;
  const keyHash = bcrypt.hashSync(rawKey, BCRYPT_ROUNDS);
  const keyPrefix = rawBytes.substring(0, 8);
  return { rawKey, keyHash, keyPrefix };
}

/**
 * Verify a submitted raw device key against a stored hash.
 */
export async function verifyDeviceKey(rawKey: string, keyHash: string): Promise<boolean> {
  try {
    return await bcrypt.compare(rawKey, keyHash);
  } catch {
    return false;
  }
}

/**
 * Generate a series key to uniquely identify a counter series.
 * A new startTimeUnixNano signals a counter reset (process restart).
 */
export function buildSeriesKey(params: {
  deviceId: string;
  model: string;
  tokenType: string;
  querySource: string;
  startTimeUnixNano: string;
  identityHash?: string;
  temporality?: number;
}): string {
  const data = JSON.stringify([params.deviceId, params.model, params.tokenType, params.querySource, params.startTimeUnixNano, params.identityHash, params.temporality]);
  return crypto.createHash('sha256').update(data).digest('hex').substring(0, 32);
}

/**
 * Hash a password for admin storage.
 */
export async function hashPassword(password: string): Promise<string> {
  return bcrypt.hash(password, BCRYPT_ROUNDS);
}

/**
 * Verify an admin password.
 */
export async function verifyPassword(password: string, hash: string): Promise<boolean> {
  return bcrypt.compare(password, hash);
}
