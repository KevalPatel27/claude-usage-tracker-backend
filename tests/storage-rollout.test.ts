/** Real MongoDB, isolated DB. Tests dual-write, rollback, backfill, and transaction abort. */
import mongoose from 'mongoose';
import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import { Device, Person, Checkpoint, UsageRecord } from '../src/models/index';
import {
  initStorage,
  UsageBucket,
  backfillStream,
  refreshReadMode,
  usageAggregate,
  STORAGE_VERSION,
} from '../src/lib/storage';
import { ingestDataPoints } from '../src/lib/ingestion';
import { verifyStorage } from '../src/scripts/storage-rollout';
import { generateDeviceKey } from '../src/lib/crypto';
import { parseOtlpMetricsPayload } from '../src/lib/otlp-parser';
const uri = process.env.TRACKER_TEST_MONGODB_URI;
const suite = uri && process.env.STORAGE_MODE === 'mirror' ? describe : describe.skip;
const start = BigInt(Date.UTC(2026, 10, 4)) * 1000000n;
const runNode = promisify(execFile);
suite('Transactional storage rollout', () => {
  const database = 'tracker_test_rollout_' + Date.now();
  let device: mongoose.Types.ObjectId, person: mongoose.Types.ObjectId;
  const dp = (v: number, t: number) => ({
    sessionId: 'rollout-session',
    identityHash: 'rollout-session',
    model: 'test-model',
    tokenType: 'input',
    querySource: 'main',
    startTimeUnixNano: String(start),
    timeUnixNano: String(start + BigInt(t)),
    asInt: v,
    aggregationTemporality: 2,
    isMonotonic: true,
  });
  const send = (v: number, t: number) => ingestDataPoints(device, person, [dp(v, t)]);
  beforeAll(async () => {
    if (!uri!.startsWith('mongodb://127.0.0.1:')) throw new Error('Loopback tests only');
    await mongoose.connect(uri!, { dbName: database });
    await Promise.all([Device.init(), Person.init(), Checkpoint.init(), UsageRecord.init()]);
    await initStorage();
  });
  beforeEach(async () => {
    await Promise.all([
      Device.deleteMany({}),
      Person.deleteMany({}),
      Checkpoint.deleteMany({}),
      UsageRecord.deleteMany({}),
      UsageBucket.deleteMany({}),
      mongoose.connection.db!.collection('storageRollout').deleteMany({}),
    ]);
    await refreshReadMode();
    person = (await Person.create({ name: 'Rollout test' }))._id;
    const k = generateDeviceKey();
    device = (
      await Device.create({
        name: 'Test device',
        personId: person,
        keyPrefix: k.keyPrefix,
        keyHash: k.keyHash,
      })
    )._id;
  });
  afterAll(async () => {
    await mongoose.connection.dropDatabase();
    await mongoose.disconnect();
  });
  test('new, late, concurrent, duplicate and reset exports keep full document parity', async () => {
    await send(1000, 10);
    await send(1600, 30);
    await send(1200, 20);
    await Promise.all([send(1800, 40), send(1800, 40), send(2000, 50)]);
    await send(50, 60);
    expect((await verifyStorage()).total).toBe(2050);
  });
  test('raw readers, compact readers and rollback include new post-cutover reports', async () => {
    await send(1000, 10);
    const proof = await verifyStorage();
    await mongoose.connection
      .db!.collection('storageRollout')
      .updateOne(
        { _id: STORAGE_VERSION as any },
        { $set: { ...proof, readMode: 'compact' } },
        { upsert: true },
      );
    await refreshReadMode();
    await send(1500, 20);
    const pipeline = [{ $group: { _id: null, total: { $sum: '$deltaTokens' } } }];
    expect((await usageAggregate(pipeline))[0].total).toBe(1500);
    await mongoose.connection
      .db!.collection('storageRollout')
      .updateOne({ _id: STORAGE_VERSION as any }, { $set: { readMode: 'raw' } });
    await refreshReadMode();
    expect((await usageAggregate(pipeline))[0].total).toBe(1500);
    expect((await verifyStorage()).total).toBe(1500);
  });
  test('historical stream backfill is resumable, locks with ingestion and retains IDs', async () => {
    await send(1000, 10);
    const stream = await Checkpoint.findOne({ deviceId: device });
    await UsageBucket.deleteMany({ deviceId: device });
    await Checkpoint.updateOne({ _id: stream!._id }, { $unset: { compactVersion: '' } });
    await Promise.all([
      backfillStream({ deviceId: device, seriesKey: stream!.seriesKey }),
      send(1400, 20),
    ]);
    await backfillStream({ deviceId: device, seriesKey: stream!.seriesKey });
    expect((await verifyStorage()).total).toBe(1400);
  });
  test('shadow failure aborts the raw insert too, then retry counts exactly once', async () => {
    await send(1000, 10);
    const spy = jest
      .spyOn(UsageBucket, 'updateOne')
      .mockRejectedValueOnce(new Error('Injected shadow failure'));
    await expect(send(1400, 20)).rejects.toThrow('Injected shadow failure');
    spy.mockRestore();
    expect(await UsageRecord.countDocuments()).toBe(1);
    expect((await verifyStorage()).total).toBe(1000);
    await send(1400, 20);
    expect((await verifyStorage()).total).toBe(1400);
  });
  test('verification refuses incomplete or mismatching shadow', async () => {
    await send(1000, 10);
    await UsageBucket.deleteMany({});
    await expect(verifyStorage()).rejects.toThrow('parity failed');
  });
  test('verified cutover accepts later exports and preserves purging with the raw collection retired', async () => {
    const payload = (value: number, time: number) => {
      const reading = dp(value, time);
      return {
        resourceMetrics: [
          {
            scopeMetrics: [
              {
                metrics: [
                  {
                    name: 'claude_code.token.usage',
                    sum: {
                      aggregationTemporality: 2,
                      isMonotonic: true,
                      dataPoints: [
                        {
                          startTimeUnixNano: reading.startTimeUnixNano,
                          timeUnixNano: reading.timeUnixNano,
                          asInt: String(value),
                          attributes: [
                            { key: 'model', value: { stringValue: reading.model } },
                            { key: 'type', value: { stringValue: reading.tokenType } },
                          ],
                        },
                      ],
                    },
                  },
                ],
              },
            ],
          },
        ],
      };
    };
    for (const [value, time] of [
      [1000, 10],
      [1500, 30],
    ]) {
      await ingestDataPoints(
        device,
        person,
        parseOtlpMetricsPayload(payload(value, time)).flatMap((metric) => metric.dataPoints),
      );
    }
    const parsed = new URL(uri!);
    parsed.pathname = '/' + database;
    const env = { ...process.env, MONGODB_URI: parsed.toString(), PORT: '0', HOST: '127.0.0.1' };
    const compactEnv = { ...env, STORAGE_MODE: 'compact' };
    const boot = ['dist/index.js'];
    await expect(
      runNode(process.execPath, boot, { env: compactEnv, timeout: 5000 }),
    ).rejects.toMatchObject({
      code: 1,
      stderr: expect.stringContaining('STORAGE_MODE_MISMATCH'),
    });
    await runNode(process.execPath, ['dist/scripts/storage-rollout.js', 'prepare-compact-only'], {
      env,
      timeout: 10000,
    });
    await expect(runNode(process.execPath, boot, { env, timeout: 5000 })).rejects.toMatchObject({
      code: 1,
      stderr: expect.stringContaining('STORAGE_MODE_MISMATCH'),
    });
    const db = mongoose.connection.db!;
    await db.dropCollection('usagerecords');
    const child = spawn(process.execPath, boot, {
      env: compactEnv,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const exited = new Promise((resolve) => child.once('exit', resolve));
    const serverAddress = new Promise<string>((resolve, reject) => {
      let stdout = '',
        stderr = '';
      child.stdout.on('data', (chunk) => {
        stdout += chunk;
        const port = stdout.match(/\[Server\] Ready (\d+)/)?.[1];
        if (port) resolve('http://127.0.0.1:' + port);
      });
      child.stderr.on('data', (chunk) => {
        stderr += chunk;
      });
      child.once('exit', (code) =>
        reject(new Error(`Compact backend exited with ${code}: ${stderr}`)),
      );
      child.once('error', reject);
    });
    const timeout = setTimeout(() => child.kill(), 20000);
    try {
      const address = await serverAddress;
      const health = await fetch(address + '/health').then((res) => res.json());
      expect(health.storage).toMatchObject({ writerMode: 'compact', readMode: 'compact' });
      const key = generateDeviceKey();
      await Device.updateOne(
        { _id: device },
        { $set: { keyHash: key.keyHash, keyPrefix: key.keyPrefix } },
      );
      const upload = (value: number, time: number) =>
        fetch(address + '/v1/metrics', {
          method: 'POST',
          headers: { 'content-type': 'application/json', 'x-tracker-key': key.rawKey },
          body: JSON.stringify(payload(value, time)),
        });
      expect((await upload(1200, 20)).status).toBe(200);
      expect((await upload(2000, 40)).status).toBe(200);
      expect((await upload(2000, 40)).status).toBe(200);
      const points = await db
        .collection('usagepoints')
        .find({ deviceId: device })
        .sort({ timeUnixNano: 1 })
        .toArray();
      expect(points.map((point) => point.deltaTokens)).toEqual([1000, 200, 300, 500]);
      const auth = await fetch(address + '/api/auth/bootstrap', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          bootstrapSecret: process.env.ADMIN_BOOTSTRAP_SECRET,
          username: 'admin',
          password: 'isolated-compact-test',
        }),
      });
      expect(auth.status).toBe(201);
      const cookie = auth.headers.get('set-cookie')!.split(';')[0];
      const stats = await fetch(address + '/api/dashboard/storage-status', {
        headers: { cookie },
      }).then((res) => res.json());
      expect(stats).toMatchObject({ mode: 'compact', rawRetained: false, logicalReadings: 4 });
      const purge = await fetch(address + '/api/people/' + person + '?purge=true', {
        method: 'DELETE',
        headers: { 'content-type': 'application/json', cookie },
        body: JSON.stringify({ confirmation: 'Rollout test' }),
      });
      expect(purge.status).toBe(204);
      expect(await db.collection('usagepoints').countDocuments({ deviceId: device })).toBe(0);
      expect(await db.listCollections({ name: 'usagerecords' }).hasNext()).toBe(false);
    } finally {
      clearTimeout(timeout);
      child.kill();
      await exited;
    }
  }, 45000);
});
