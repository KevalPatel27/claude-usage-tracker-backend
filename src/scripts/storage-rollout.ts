/** Operator CLI. Uses existing backend .env; never prints connection strings or documents. */
import 'dotenv/config';
import mongoose from 'mongoose';
import { createHash } from 'node:crypto';
import { EJSON } from 'bson';
import { UsageRecord } from '../models/index.js';
import {
  backfillStream,
  initStorage,
  mirrorWrites,
  STORAGE_VERSION,
  UsageBucket,
} from '../lib/storage.js';

const stable = (x: any): any =>
  Array.isArray(x)
    ? x.map(stable)
    : x && typeof x === 'object'
      ? Object.fromEntries(
          Object.keys(x)
            .sort()
            .map((k) => [k, stable(x[k])]),
        )
      : x;
const canonical = (x: any) => JSON.stringify(stable(EJSON.serialize(x, { relaxed: false })));
export async function verifyStorage() {
  const session = await mongoose.startSession();
  let proof: any;
  try {
    await session.withTransaction(
      async () => {
        const hash = async (name: string) => {
          // Sorting the expanded view can exceed Atlas Free's server memory limit.
          // Retain only fixed-size document hashes locally, including duplicate occurrences.
          const documentHashes: Buffer[] = [];
          let total = 0;
          for await (const row of mongoose.connection.db!.collection(name).find({}, { session })) {
            documentHashes.push(createHash('sha256').update(canonical(row)).digest());
            total += row.deltaTokens;
          }
          documentHashes.sort(Buffer.compare);
          const digest = createHash('sha256');
          for (const documentHash of documentHashes) digest.update(documentHash);
          return { count: documentHashes.length, total, sha256: digest.digest('hex') };
        };
        const raw = await hash('usagerecords'),
          compact = await hash('usagepoints');
        if (canonical(raw) !== canonical(compact))
          throw new Error('Raw/compact parity failed; readers left unchanged');
        proof = { ...raw, verifiedVersion: STORAGE_VERSION, verifiedAt: new Date() };
      },
      { readConcern: { level: 'snapshot' }, writeConcern: { w: 'majority', j: true } },
    );
  } finally {
    await session.endSession();
  }
  return proof;
}
export async function backfillAll() {
  const streams = UsageRecord.aggregate([
    { $group: { _id: { deviceId: '$deviceId', seriesKey: '$seriesKey' } } },
    { $sort: { '_id.deviceId': 1, '_id.seriesKey': 1 } },
  ]).cursor({ batchSize: 50 });
  let completed = 0;
  for await (const row of streams) {
    await backfillStream(row._id);
    completed++;
  }
  return { completedStreams: completed };
}
async function main() {
  if (!mirrorWrites) throw new Error('Set STORAGE_MODE=mirror for rollout operations');
  const uri = process.env.MONGODB_URI;
  if (!uri) throw new Error('MONGODB_URI required');
  await mongoose.connect(uri, { serverSelectionTimeoutMS: 10000 });
  try {
    const command = process.argv[2] ?? 'status';
    if (
      ![
        'status',
        'backfill',
        'verify',
        'read-compact',
        'read-raw',
        'prepare-compact-only',
      ].includes(command)
    )
      throw new Error('Unknown command');
    await initStorage();
    const controls = mongoose.connection.db!.collection('storageRollout'),
      filter = { _id: STORAGE_VERSION as any };
    if ((await controls.findOne(filter))?.compactOnlyVersion === STORAGE_VERSION) {
      if (command !== 'status') throw new Error('Compact-only cutover has already been prepared.');
      console.log(
        JSON.stringify({ compactOnlyPrepared: true, journals: await UsageBucket.countDocuments() }),
      );
      return;
    }
    if (command === 'prepare-compact-only') {
      const rawExists = await mongoose.connection
        .db!.listCollections({ name: 'usagerecords', type: 'collection' })
        .hasNext();
      if (!rawExists) throw new Error('Expected the raw collection before preparing the cutover.');
      const proof = await verifyStorage();
      await controls.updateOne(
        filter,
        { $set: { ...proof, compactOnlyVersion: STORAGE_VERSION } },
        { upsert: true, writeConcern: { w: 'majority', j: true } },
      );
      console.log(
        JSON.stringify({
          compactOnlyPrepared: true,
          records: proof.count,
          totalTokens: proof.total,
        }),
      );
      return;
    }
    if (command === 'backfill') console.log(JSON.stringify(await backfillAll()));
    if (command === 'verify' || command === 'read-compact') {
      const proof = await verifyStorage();
      await controls.updateOne(
        filter,
        { $set: { ...proof, ...(command === 'read-compact' ? { readMode: 'compact' } : {}) } },
        { upsert: true },
      );
      console.log(
        JSON.stringify({
          parity: true,
          records: proof.count,
          totalTokens: proof.total,
          sha256: proof.sha256,
        }),
      );
    }
    if (command === 'read-raw')
      await controls.updateOne(
        filter,
        { $set: { readMode: 'raw', updatedAt: new Date() } },
        { upsert: true },
      );
    const control = await controls.findOne(filter);
    console.log(
      JSON.stringify({
        writerMode: 'mirror',
        requestedReadMode: control?.readMode ?? 'raw',
        verifiedAt: control?.verifiedAt ?? null,
        rawRetained: true,
        journals: await UsageBucket.countDocuments(),
      }),
    );
  } finally {
    await mongoose.disconnect();
  }
}
if (require.main === module)
  main().catch(() => {
    console.error(
      'Storage rollout stopped. Raw records retained; inspect verification and writer readiness. Connection details withheld.',
    );
    process.exitCode = 1;
  });
