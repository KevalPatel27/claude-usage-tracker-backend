/** Synthetic prompts only; isolated local replica-set database, never collected usage. */
import mongoose from 'mongoose';
import request from 'supertest';
import { app } from '../src/app';
import { Admin, Device, Person, UsageRecord, Checkpoint } from '../src/models';
import { PromptTurn, PromptErasure, SessionProject } from '../src/models/history';
import { generateDeviceKey } from '../src/lib/crypto';

const uri = process.env.TRACKER_TEST_MONGODB_URI;
(uri ? describe : describe.skip)('Prompt history against real MongoDB', () => {
  let cookie: string, key: string, device: string, person: string;
  const models = [Admin, Device, Person, UsageRecord, Checkpoint, PromptTurn, PromptErasure, SessionProject];
  beforeAll(async () => {
    if (!uri?.startsWith('mongodb://127.0.0.1:')) throw Error('Only isolated loopback MongoDB allowed');
    await mongoose.connect(uri, { dbName: 'tracker_history_test_' + Date.now(), serverSelectionTimeoutMS: 5000 });
    await Promise.all(models.map(m => m.init()));
    const auth = await request(app).post('/api/auth/bootstrap').send({ username: 'admin', password: 'isolated-history-test-password', bootstrapSecret: process.env.ADMIN_BOOTSTRAP_SECRET });
    expect(auth.status).toBe(201); cookie = auth.headers['set-cookie'][0];
  });
  afterAll(async () => { if (mongoose.connection.readyState === 1) await mongoose.connection.dropDatabase(); await mongoose.disconnect(); });
  beforeEach(async () => {
    await Promise.all([Device.deleteMany({}),Person.deleteMany({}),UsageRecord.deleteMany({}),Checkpoint.deleteMany({}),PromptTurn.deleteMany({}),PromptErasure.deleteMany({}),SessionProject.deleteMany({})]);
    person = String((await Person.create({ name: 'History person' }))._id);
    const k = generateDeviceKey(); key = k.rawKey;
    device = String((await Device.create({ name: 'History PC', personId: person, keyHash: k.keyHash, keyPrefix: k.keyPrefix, promptCollectionEnabled: true }))._id);
  });
  const call = (method: 'get' | 'patch' | 'delete', path: string, body?: object) => request(app)[method]('/api' + path).set('Cookie', cookie).send(body);
  function events(prompt = 'Synthetic login task', promptId = 'prompt-1', sessionId = 'session-1') {
    const start = Date.now() - 30000;
    return [{ type: 'submit', sessionId, promptId, observedAt: new Date(start).toISOString(), prompt, promptLength: Array.from(prompt).length },
      { type: 'stop', sessionId, promptId, observedAt: new Date(start + 15000).toISOString() }];
  }
  const send = (ev: object[], overrides: object = {}) => request(app).post('/v1/history').set('X-Tracker-Key', key).send({ version: 2, deviceId: device,
    diagnostics: { setupVersion: '2.0.0', platform: 'windows', pendingCount: 0, droppedCount: 0 }, events: ev, ...overrides });

  test('history-aware onboarding needs both a fresh prompt and a positive token report', async () => {
    const path = '/dashboard/verify-device/' + device + '?since=' + encodeURIComponent(new Date(Date.now() - 60000).toISOString()) + '&history=true';
    expect((await call('get', path)).body).toMatchObject({verified:false,historyVerified:false});
    await send(events());
    expect((await call('get', path)).body).toMatchObject({verified:false,historyVerified:true});
    const metricsOnly = await call('get', '/dashboard/verify-device/' + device);
    expect(metricsOnly.body.historyVerified).toBeNull();
    await Device.updateOne({_id:device},{$set:{promptCollectionEnabled:false}});
    expect((await call('get', path)).body.historyVerified).toBe(false);
  });

  test('admin APIs reject device keys; ingestion rejects admin cookie and revoked/disabled keys', async () => {
    expect((await request(app).get('/api/history/overview').set('X-Tracker-Key', key)).status).toBe(401);
    expect((await request(app).post('/v1/history').set('Cookie', cookie).send({})).status).toBe(401);
    await call('patch', '/devices/' + device + '/prompt-history', { enabled: false });
    expect((await send(events())).status).toBe(403);
    expect(await PromptTurn.countDocuments()).toBe(0);
    await call('patch', '/devices/' + device + '/prompt-history', { enabled: true });
    expect((await send(events())).status).toBe(200);
    await Device.updateOne({ _id: device }, { $set: { revokedAt: new Date() } });
    expect((await send(events())).status).toBe(401);
  });
  test('duplicate/concurrent exports count once; stops can arrive before submission and after reconnect', async () => {
    const ev = events();
    expect((await send([ev[1]])).status).toBe(200);
    const results = await Promise.all([send([ev[0]]), send(ev), send(ev)]);
    expect(results.map(r => r.status)).toEqual([200, 200, 200]);
    expect(await PromptTurn.countDocuments()).toBe(1);
    const row = (await PromptTurn.findOne())!;
    expect(row.promptText).toBe('Synthetic login task'); expect(+row.completedAt! - +row.submittedAt!).toBe(15000);
    const dbName = mongoose.connection.name;
    await mongoose.disconnect(); await mongoose.connect(uri!, { dbName });
    expect((await send(ev)).status).toBe(200); expect(await PromptTurn.countDocuments()).toBe(1);
  });
  test('session identity is scoped to device and concurrent sessions stay separate', async () => {
    await Promise.all([send(events('A', 'same', 'first')), send(events('B', 'same', 'second'))]);
    const other = generateDeviceKey();
    const d = await Device.create({ name: 'Other', keyHash: other.keyHash, keyPrefix: other.keyPrefix, promptCollectionEnabled: true });
    expect((await request(app).post('/v1/history').set('X-Tracker-Key', other.rawKey).send({ version: 2, deviceId: String(d._id), diagnostics: { setupVersion: '2.0.0', platform: 'linux', pendingCount: 0, droppedCount: 0 }, events: events('C', 'same', 'first') })).status).toBe(200);
    expect(await PromptTurn.countDocuments()).toBe(3);
  });
  test('unknown/assistant fields and wrong-device binding are rejected without storing content', async () => {
    expect((await send([{ ...events()[0], assistant_response: 'NEVER STORE' }])).status).toBe(400);
    expect((await send(events(), { response: 'NEVER STORE' })).status).toBe(400);
    expect((await send(events(), { deviceId: '111111111111111111111111' })).status).toBe(403);
    expect(await PromptTurn.countDocuments()).toBe(0);
  });
  test('invalid/oversized bodies and old/future clocks are rejected; Unicode lengths use code points', async () => {
    const ev = events('👋'); expect((await send(ev)).status).toBe(200);
    expect((await send([{ ...events()[0], prompt: 'x'.repeat(16001), promptLength: 16001 }])).status).toBe(400);
    expect((await send([{ ...events()[0], observedAt: new Date(Date.now() - 8 * 86400000).toISOString() }])).status).toBe(400);
    expect((await send([{ ...events()[0], observedAt: new Date(Date.now() + 3600000).toISOString() }])).status).toBe(400);
  });
  test('conflicting submission rolls back its entire batch and does not replace prompt text', async () => {
    const ev = events(); await send(ev);
    expect((await send([events('Another', 'new')[0], { ...ev[0], prompt: 'Changed text' }])).status).toBe(409);
    expect(await PromptTurn.countDocuments()).toBe(1); expect((await PromptTurn.findOne())?.promptText).toBe('Synthetic login task');
  });
  test('repeated Stop observations extend completion; older retries cannot shorten it', async () => {
    const ev = events(); await send(ev);
    const later = { ...ev[1], observedAt: new Date(new Date(ev[1].observedAt).getTime() + 10000).toISOString() };
    await send([later]); await send([ev[1]]);
    const row = (await PromptTurn.findOne())!; expect(+row.completedAt! - +row.submittedAt!).toBe(25000);
  });
  test('charts, counts, search, tags, detail and CSV reflect the same prompt set', async () => {
    await send(events('=Synthetic login,\nvalidation task')); await send(events('Synthetic payments task', 'p2', 's2'));
    expect((await call('patch', '/history/sessions/' + device + '/session-1', { project: 'Portal' })).status).toBe(200);
    const summary = await call('get', '/history/overview?project=Portal&search=login&timezone=Asia/Kolkata');
    expect(summary.status).toBe(200); expect(summary.body.stats.prompts).toBe(1); expect(summary.body.stats.sessions).toBe(1);
    expect(summary.body.stats.averageDurationMs).toBe(15000); expect(summary.body.daily[0].prompts).toBe(1); expect(summary.body.lengths[0].prompts).toBe(1);
    expect(summary.body.rows[0].personName).toBe('History person'); expect(summary.body.rows[0].project).toBe('Portal');
    const detail = await call('get', '/history/sessions/' + device + '/session-1');
    expect(detail.body.rows[0].promptText).toContain('login,\nvalidation');
    const csv = await call('get', '/history/export.csv?project=Portal&search=login');
    expect(csv.status).toBe(200); expect(csv.text).toContain("'=" + 'Synthetic login,'); expect(csv.text).not.toContain('payments');
    expect((await call('get', '/history/overview?page=-1')).status).toBe(400);
    expect((await call('get', '/history/overview?model=opus')).status).toBe(400);
  });
  test('incomplete or reversed timestamps never become zero-duration completed work', async () => {
    const ev = events(); await send([{ ...ev[1], observedAt: new Date(new Date(ev[0].observedAt).getTime() - 1000).toISOString() }, ev[0]]);
    const result = await call('get', '/history/overview');
    expect(result.body.stats.averageDurationMs).toBeNull(); expect(result.body.stats.completed).toBe(0); expect(result.body.stats.incomplete).toBe(1);
  });
  test('expired rows are not served while TTL cleanup is pending', async () => {
    await send(events()); await PromptTurn.updateMany({}, { $set: { expiresAt: new Date(Date.now() - 1000) } });
    expect((await call('get', '/history/overview')).body.stats.prompts).toBe(0);
    expect((await call('get', '/history/sessions/' + device + '/session-1')).body.total).toBe(0);
  });
  test('permanent prompt deletion prevents queued retries from restoring content', async () => {
    const ev = events(); await send(ev); const row = (await PromptTurn.findOne())!;
    expect((await call('delete', '/history/prompts/' + row._id, { confirmation: 'wrong' })).status).toBe(409);
    expect((await call('delete', '/history/prompts/' + row._id, { confirmation: 'DELETE PROMPT' })).status).toBe(204);
    expect((await send(ev)).status).toBe(200); expect(await PromptTurn.countDocuments()).toBe(0);
    const tombstone = (await PromptErasure.findOne().lean())!;
    expect(Object.keys(tombstone).sort()).toEqual(['_id', 'deviceId', 'identityHash']);
  });
  test('person purge erases only that assignment and blocks replay after reassignment', async () => {
    const ev = events(); await send(ev); const other = await Person.create({ name: 'Next person' });
    await call('patch', '/devices/' + device + '/assign', { personId: String(other._id) });
    await send(events('Other person task', 'other'));
    expect((await call('delete', '/people/' + person + '?purge=true', { confirmation: 'History person' })).status).toBe(204);
    await send(ev); expect(await PromptTurn.countDocuments()).toBe(1); expect((await PromptTurn.findOne())?.promptText).toBe('Other person task');
  });
  test('device purge removes history and project records and prevents future ingestion', async () => {
    await send(events()); await call('patch', '/history/sessions/' + device + '/session-1', { project: 'Portal' });
    expect((await call('delete', '/devices/' + device + '?purge=true', { confirmation: 'History PC' })).status).toBe(204);
    expect(await PromptTurn.countDocuments()).toBe(0); expect(await SessionProject.countDocuments()).toBe(0);
    expect((await send(events())).status).toBe(401);
  });
  test('diagnostics show declared setup and receipt without keys or claiming token delivery', async () => {
    await send(events()); const response = await call('get', '/history/diagnostics');
    expect(response.body.devices[0].historySetupVersion).toBe('2.0.0'); expect(response.body.devices[0].lastHistoryReportAt).toBeTruthy();
    expect(response.body.devices[0].lastReportAt).toBeNull(); expect(JSON.stringify(response.body)).not.toContain('keyHash');
  });
});
