import mongoose from 'mongoose';
import { Admin, Checkpoint, Device, Person, UsageRecord } from '../src/models';

const record = () => ({ deviceId: new mongoose.Types.ObjectId(), exportedAt: new Date(),
  timeUnixNano: '01700000000000000000', intervalStart: '01700000000000000000', startTimeUnixNano: '1700000000000000000',
  temporality: 2, usageModel: 'test-model', tokenType: 'input', querySource: 'main',
  deltaTokens: 42, cumulativeAtExport: 42, seriesKey: 'isolated-test-stream' });

describe('Persistence validation', () => {
  test('valid telemetry and all supported token categories remain valid', () => {
    for (const tokenType of ['input', 'output', 'cacheRead', 'cacheCreation']) {
      expect(new UsageRecord({ ...record(), tokenType, deltaTokens: 0 }).validateSync()).toBeUndefined();
    }
  });
  test.each([-1, 0.5, Infinity, NaN, Number.MAX_SAFE_INTEGER + 1])('rejects invalid token count %s', value => {
    for (const field of ['deltaTokens', 'cumulativeAtExport']) {
      expect(new UsageRecord({ ...record(), [field]: value }).validateSync()?.errors[field]).toBeDefined();
    }
    expect(new Checkpoint({ deviceId: new mongoose.Types.ObjectId(), seriesKey: 'test', lastCumulative: value }).validateSync()).toBeDefined();
  });
  test.each([
    ['temporality', 3], ['tokenType', 'unknown'], ['timeUnixNano', 'not-a-timestamp'],
    ['intervalStart', '-5'], ['startTimeUnixNano', '1'.repeat(21)], ['usageModel', 'm'.repeat(201)],
    ['querySource', 'q'.repeat(201)],
  ])('rejects invalid %s', (field, value) => {
    expect(new UsageRecord({ ...record(), [field]: value }).validateSync()?.errors[field]).toBeDefined();
  });
  test('person/device names enforce the same maximum and trimmed nonempty names', () => {
    for (const name of [' '.repeat(3), 'n'.repeat(121)]) {
      expect(new Person({ name }).validateSync()?.errors.name).toBeDefined();
      expect(new Device({ name, keyHash: 'test-hash', keyPrefix: '12345678' }).validateSync()?.errors.name).toBeDefined();
    }
  });
});

const uri = process.env.TRACKER_TEST_MONGODB_URI;
(uri ? describe : describe.skip)('Indexes on isolated real MongoDB', () => {
  beforeAll(async () => {
    if (!uri?.startsWith('mongodb://127.0.0.1:')) throw Error('Only isolated loopback MongoDB allowed');
    await mongoose.connect(uri, { dbName: 'tracker_schema_test_' + Date.now(), serverSelectionTimeoutMS: 5000 });
    await Promise.all([Admin.init(), Checkpoint.init(), Device.init(), Person.init(), UsageRecord.init()]);
  });
  afterAll(async () => { if (mongoose.connection.readyState === 1) await mongoose.connection.dropDatabase(); await mongoose.disconnect(); });
  test('model/date and authenticated key lookup use their indexes without collection scans', async () => {
    const deviceId = new mongoose.Types.ObjectId();
    await UsageRecord.insertMany(Array.from({ length: 250 }, (_, n) => ({ ...record(), deviceId,
      seriesKey: 'stream-' + n, usageModel: n === 42 ? 'selected-model' : 'other-model' })));
    await Device.insertMany(Array.from({ length: 100 }, (_, n) => ({ name: 'Test ' + n,
      keyHash: 'synthetic-hash', keyPrefix: String(n).padStart(8, '0') })));
    const usage = await UsageRecord.collection.find({ usageModel: 'selected-model', exportedAt: { $gte: new Date(0) } }).sort({ exportedAt: -1 }).explain('executionStats');
    const device = await Device.collection.find({ keyPrefix: '00000042', revokedAt: null, archivedAt: null }).explain('executionStats');
    for (const [plan, index] of [[usage, 'usage_model_period'], [device, 'ingestion_key_lookup']] as const) {
      expect(JSON.stringify(plan.queryPlanner.winningPlan)).toContain(index);
      expect(plan.executionStats.nReturned).toBe(1);
      expect(plan.executionStats.totalDocsExamined).toBeLessThanOrEqual(2);
    }
    // The existing durable replay constraint still rejects duplicate exports.
    const sample = (await UsageRecord.findOne().lean())!;
    const { _id, ...duplicate } = sample;
    await expect(UsageRecord.create(duplicate)).rejects.toMatchObject({ code: 11000 });
  });
});
