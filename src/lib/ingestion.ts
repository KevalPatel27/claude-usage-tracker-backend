/** Durable per-series serialization. All reads, inserts and neighbor corrections are transactional. */
import mongoose, { Types } from 'mongoose';
import { Checkpoint, Device, UsageRecord } from '../models/index.js';
import { buildSeriesKey } from './crypto.js';
import { ParsedDataPoint } from './otlp-parser.js';
export class CounterConflict extends Error {}
const nanoKey = (value: string) => BigInt(value).toString().padStart(20, '0');
const increment = (current: number, previous?: number) => previous === undefined || current < previous ? current : current - previous;
export async function ingestDataPoints(deviceId: Types.ObjectId, _person: Types.ObjectId | null, points: ParsedDataPoint[]) {
  let inserted = 0, skipped = 0;
  for (const dp of points) {
    // Delta intervals change start on each export; stream identity must not include it.
    const seriesKey = buildSeriesKey({ deviceId: deviceId.toHexString(), model: dp.model,
      tokenType: dp.tokenType, querySource: dp.querySource,
      startTimeUnixNano: dp.aggregationTemporality === 2 ? dp.startTimeUnixNano : '',
      identityHash: dp.identityHash, temporality: dp.aggregationTemporality });
    const filter = { deviceId, seriesKey };
    const session = await mongoose.startSession();
    let didInsert = false;
    try {
      await session.withTransaction(async () => {
        didInsert = false; // callback can be retried by driver
        // A device write serializes ingestion with reassignment, revocation and deletion.
        const device = await Device.findOneAndUpdate({ _id: deviceId, revokedAt: null, archivedAt: null }, { $inc: { revision: 1 } }, { new: true, session });
        if (!device) throw new CounterConflict('Device no longer active');
        await Checkpoint.updateOne(filter, { $inc: { revision: 1 } }, { session, upsert: true });
        const timeUnixNano = nanoKey(dp.timeUnixNano), intervalStart = nanoKey(dp.startTimeUnixNano);
        const checkpoint = await Checkpoint.findOne(filter).session(session);
        const floor = checkpoint?.purgedThroughTimeUnixNano;
        if (floor && timeUnixNano <= floor) return; // Acknowledge discarded historical retries without restoring erased data.
        if (floor && dp.aggregationTemporality === 1 && intervalStart < floor) throw new CounterConflict('Delta interval crosses permanently deleted history; start a new session');
        // An exact stream fingerprint already includes session.id. A new readable ID can
        // safely label that stream's older samples without modifying accounting values.
        if (dp.sessionId) await UsageRecord.updateMany({ ...filter, sessionId: null }, { $set: { sessionId: dp.sessionId } }, { session });
        const same = await UsageRecord.findOne({ ...filter, timeUnixNano }).session(session);
        if (same) {
          if (same.cumulativeAtExport !== dp.asInt || same.intervalStart !== intervalStart) throw new CounterConflict('Conflicting export at the same timestamp');
          return;
        }
        const previous = await UsageRecord.findOne({ ...filter, timeUnixNano: { $lt: timeUnixNano } }).sort({ timeUnixNano: -1 }).session(session);
        const next = await UsageRecord.findOne({ ...filter, timeUnixNano: { $gt: timeUnixNano } }).sort({ timeUnixNano: 1 }).session(session);
        if (dp.aggregationTemporality === 1 && ((previous && previous.timeUnixNano > intervalStart) || (next && next.intervalStart < timeUnixNano))) {
          throw new CounterConflict('Overlapping delta intervals; use cumulative setup');
        }
        const previousValue = floor && (!previous || previous.timeUnixNano <= floor) ? checkpoint?.purgedCumulative : previous?.cumulativeAtExport;
        const deltaTokens = dp.aggregationTemporality === 1 ? dp.asInt : increment(dp.asInt, previousValue);
        await UsageRecord.create([{ deviceId, sessionId: dp.sessionId ?? null, personIdAtTime: next && dp.aggregationTemporality === 2 ? next.personIdAtTime : device.personId, seriesKey,
          exportedAt: new Date(Number(BigInt(dp.timeUnixNano) / 1000000n)), timeUnixNano, intervalStart,
          temporality: dp.aggregationTemporality, usageModel: dp.model, tokenType: dp.tokenType,
          querySource: dp.querySource, deltaTokens, cumulativeAtExport: dp.asInt, startTimeUnixNano: dp.startTimeUnixNano }], { session });
        // Late cumulative exports split the successor's interval instead of adding overlapping totals.
        if (next && dp.aggregationTemporality === 2) {
          await UsageRecord.updateOne({ _id: next._id }, { $set: { deltaTokens: increment(next.cumulativeAtExport, dp.asInt) } }, { session });
        }
        await Checkpoint.updateOne(filter, { $set: { lastCumulative: next?.cumulativeAtExport ?? dp.asInt,
          lastStartTimeUnixNano: dp.startTimeUnixNano, updatedAt: new Date() } }, { session });
        didInsert = true;
      }, { readConcern: { level: 'snapshot' }, writeConcern: { w: 'majority', j: true } });
    } finally { await session.endSession(); }
    if (didInsert) inserted++; else skipped++;
  }
  // A separate durable receipt covers token-free startup/idle exports too.
  await Device.updateOne({ _id: deviceId, revokedAt: null, archivedAt: null }, { $max: { lastReportAt: new Date() } }, { writeConcern: { w: 'majority', j: true } });
  return { inserted, skipped, errors: [] };
}
