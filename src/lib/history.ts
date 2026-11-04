import { createHash } from 'crypto';
import { z } from 'zod';
import { ClientSession, Types } from 'mongoose';
import { Device } from '../models/index.js';
import { PromptTurn, PromptErasure } from '../models/history.js';
import { fail, transaction } from './management.js';

const id = z.string().regex(/^[A-Za-z0-9._:-]{1,128}$/);
const common = { sessionId: id, promptId: id, observedAt: z.string().datetime({ offset: true }) };
export const historyBatch = z.object({
  version: z.literal(2), deviceId: z.string().regex(/^[a-f0-9]{24}$/i),
  diagnostics: z.object({ setupVersion: z.string().max(30).regex(/^\d+\.\d+\.\d+$/), platform: z.enum(['windows', 'macos', 'linux']),
    pendingCount: z.number().int().min(0).max(5000), droppedCount: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER) }).strict(),
  events: z.array(z.discriminatedUnion('type', [
    z.object({ ...common, type: z.literal('submit'), prompt: z.string().max(32000), promptLength: z.number().int().min(0).max(10000000) }).strict(),
    z.object({ ...common, type: z.literal('stop') }).strict(),
  ])).min(1).max(20),
}).strict();
export type HistoryBatch = z.infer<typeof historyBatch>;
export function historyRetentionDays() {
  const value = process.env.PROMPT_RETENTION_DAYS ?? '30';
  if (!/^\d+$/.test(value) || +value < 1 || +value > 365) throw new Error('PROMPT_RETENTION_DAYS must be 1–365');
  return +value;
}
export const promptIdentity = (sessionId: string, promptId: string) => createHash('sha256').update(JSON.stringify([sessionId, promptId])).digest('hex');

export async function ingestHistory(device: { _id: Types.ObjectId; keyHash: string }, batch: HistoryBatch) {
  if (String(device._id) !== batch.deviceId) fail(403, 'This key belongs to another device. Rerun setup for the correct device.');
  const now = new Date(), retention = historyRetentionDays() * 86400000;
  for (const event of batch.events) {
    const at = new Date(event.observedAt).getTime();
    if (at > now.getTime() + 5 * 60000 || at < now.getTime() - 7 * 86400000) fail(400, 'Report timestamp is outside the supported seven-day delivery window.');
    if (event.type === 'submit' && (Array.from(event.prompt).length > 16000 || event.promptLength < Array.from(event.prompt).length)) fail(400, 'Invalid prompt length.');
  }
  return transaction(async session => {
    const current = await Device.findOneAndUpdate({ _id: device._id, keyHash: device.keyHash, revokedAt: null, archivedAt: null }, { $inc: { revision: 1 } }, { new: true, session });
    if (!current) return fail(401, 'Device key is no longer active.');
    if (!current.promptCollectionEnabled) return fail(403, 'Prompt history is disabled for this device.');
    let accepted = 0;
    for (const event of batch.events) {
      const filter = { deviceId: current._id, sessionId: event.sessionId, promptId: event.promptId };
      if (await PromptErasure.exists({ deviceId: current._id, identityHash: promptIdentity(event.sessionId, event.promptId) }).session(session)) continue;
      const at = new Date(event.observedAt), expiry = new Date(at.getTime() + retention);
      if (expiry <= now) continue; // Expired content must never be restored by delayed reports.
      const fingerprint = createHash('sha256').update(JSON.stringify(event)).digest('hex');
      const existing = await PromptTurn.findOne(filter).session(session);
      const field = event.type === 'submit' ? 'submitFingerprint' : 'stopFingerprint';
      if (existing?.[field]) {
        if (event.type === 'submit') {
          if (existing[field] !== fingerprint) fail(409, 'Conflicting report for an existing prompt event.');
          continue;
        }
        // Stop hooks can run again if another hook continues the same prompt.
        // Keep the latest observed completion; older retries cannot shorten it.
        if (existing.completedAt && existing.completedAt >= at) continue;
      }
      const update = event.type === 'submit' ? { submittedAt: at, promptText: event.prompt, promptLength: event.promptLength,
        truncated: event.promptLength > Array.from(event.prompt).length, submitFingerprint: fingerprint, personIdAtTime: current.personId } : { completedAt: at, stopFingerprint: fingerprint };
      await PromptTurn.updateOne(filter, { $set: update, $min: { expiresAt: expiry }, $setOnInsert: { createdAt: now,
        ...(event.type === 'stop' ? { personIdAtTime: current.personId } : {}) } }, { upsert: true, runValidators: true, session });
      accepted++;
    }
    await Device.updateOne({ _id: current._id }, { $set: { lastHistoryReportAt: now, historySetupVersion: batch.diagnostics.setupVersion,
      historyPlatform: batch.diagnostics.platform, historyPendingCount: batch.diagnostics.pendingCount, historyDroppedCount: batch.diagnostics.droppedCount } }, { session });
    return { accepted, retentionDays: historyRetentionDays() };
  });
}

export async function erasePromptRows(rows: Array<{ deviceId: Types.ObjectId; sessionId: string; promptId: string; _id: Types.ObjectId }>, session: ClientSession) {
  for (const row of rows) {
    await PromptErasure.updateOne({ deviceId: row.deviceId, identityHash: promptIdentity(row.sessionId, row.promptId) }, { $setOnInsert: { deviceId: row.deviceId } }, { upsert: true, session });
  }
  if (rows.length) await PromptTurn.deleteMany({ _id: { $in: rows.map(r => r._id) } }, { session });
}

// Durations are observed turn intervals, never API latency or employee working time.
export const durationExpression = { $cond: [{ $and: [{ $ne: ['$submittedAt', null] }, { $ne: ['$completedAt', null] },
  { $gte: ['$completedAt', '$submittedAt'] }, { $lte: [{ $subtract: ['$completedAt', '$submittedAt'] }, 7 * 86400000] }] }, { $subtract: ['$completedAt', '$submittedAt'] }, null] };
