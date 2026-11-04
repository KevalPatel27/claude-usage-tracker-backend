import { Router } from 'express';
import { Types } from 'mongoose';
import { z } from 'zod';
import { Device, Person, UsageRecord } from '../models/index.js';
import { PromptTurn, SessionProject } from '../models/history.js';
import { requireAdmin } from '../middleware/auth.js';
import { authenticateDeviceKey } from '../lib/device-auth.js';
import { route } from '../lib/route.js';
import { usageQuery, csvCell } from '../lib/query.js';
import { durationExpression, erasePromptRows, historyBatch, historyRetentionDays, ingestHistory } from '../lib/history.js';
import { fail, lockDevice, transaction } from '../lib/management.js';

export const historyIngestRouter = Router();
historyIngestRouter.post('/history', route(async (req, res) => {
  const device = await authenticateDeviceKey(req.headers['x-tracker-key']);
  if (!device) return res.status(401).json({ error: 'Invalid or revoked device key.' });
  const parsed = historyBatch.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: 'Invalid history report. Only approved prompt/completion fields are accepted.' });
  const result = await ingestHistory(device, parsed.data);
  res.setHeader('Cache-Control', 'no-store');
  return res.json(result);
}));

export const historyRouter = Router();
historyRouter.use(requireAdmin);
historyRouter.use((_req, res, next) => { res.setHeader('Cache-Control', 'no-store'); next(); });
const identifier = /^[A-Za-z0-9._:-]{1,128}$/;
historyRouter.param('deviceId', (_req, res, next, id) => /^[a-f0-9]{24}$/i.test(id) ? next() : res.status(400).json({ error: 'Invalid device ID' }));
historyRouter.param('sessionId', (_req, res, next, id) => identifier.test(id) ? next() : res.status(400).json({ error: 'Invalid session ID' }));
historyRouter.param('promptId', (_req, res, next, id) => /^[a-f0-9]{24}$/i.test(id) ? next() : res.status(400).json({ error: 'Invalid prompt record ID' }));

function filters(query: Record<string, unknown>) {
  const q = usageQuery(query), { exportedAt, ...identity } = q.match;
  const match: Record<string, unknown> = { ...identity, expiresAt: { $gt: new Date() },
    $or: [{ submittedAt: exportedAt }, { submittedAt: null, completedAt: exportedAt }] };
  // Model usage is session-level, so it is deliberately not a prompt filter.
  if (query.model) fail(400, 'Model filtering is available in recorded usage, not individual prompts.');
  if (query.search !== undefined) {
    if (typeof query.search !== 'string' || query.search.length > 120) fail(400, 'Search must be up to 120 characters.');
    if (typeof query.search === 'string' && query.search.trim()) match.$text = { $search: query.search.trim() };
  }
  if (query.project !== undefined && (typeof query.project !== 'string' || query.project.length > 80)) fail(400, 'Invalid project tag.');
  const project = typeof query.project === 'string' ? query.project.trim() : '';
  return { ...q, match, project };
}
function pageNumber(query: Record<string, unknown>) {
  const value = query.page ?? '0';
  if (typeof value !== 'string' || !/^(0|[1-9]\d{0,4})$/.test(value)) return fail(400, 'Invalid page.');
  return +value;
}
const projectLookup = { $lookup: { from: SessionProject.collection.name, let: { device: '$deviceId', session: '$sessionId' },
  pipeline: [{ $match: { $expr: { $and: [{ $eq: ['$deviceId', '$$device'] }, { $eq: ['$sessionId', '$$session'] }] } } }, { $project: { project: 1 } }], as: 'tag' } };
function basePipeline(q: ReturnType<typeof filters>): any[] {
  return [{ $match: q.match }, projectLookup, { $set: { project: { $ifNull: [{ $arrayElemAt: ['$tag.project', 0] }, ''] }, durationMs: durationExpression } },
    ...(q.project ? [{ $match: { project: q.project } }] : [])];
}
async function namedRows(rows: any[]) {
  const [devices, people] = await Promise.all([
    Device.find({ _id: { $in: rows.map(r => r.deviceId) } }).select('name').lean(),
    Person.find({ _id: { $in: rows.map(r => r.personIdAtTime).filter(Boolean) } }).select('name').lean(),
  ]);
  const ds = new Map(devices.map(d => [String(d._id), d.name])), ps = new Map(people.map(p => [String(p._id), p.name]));
  return rows.map(r => ({ ...r, deviceName: ds.get(String(r.deviceId)) ?? 'Removed device', personName: ps.get(String(r.personIdAtTime)) ?? 'Unassigned' }));
}
const rowProjection = { deviceId: 1, sessionId: 1, promptId: 1, personIdAtTime: 1, submittedAt: 1, completedAt: 1,
  promptLength: 1, truncated: 1, project: 1, durationMs: 1, promptPreview: { $substrCP: [{ $ifNull: ['$promptText', ''] }, 0, 220] } };

historyRouter.get('/overview', route(async (req, res) => {
  const q = filters(req.query), page = pageNumber(req.query), limit = 25;
  const [result] = await PromptTurn.aggregate([...basePipeline(q), { $facet: {
    rows: [{ $sort: { submittedAt: -1, _id: -1 } }, { $skip: page * limit }, { $limit: limit + 1 }, { $project: rowProjection }],
    stats: [{ $group: { _id: null, records: { $sum: 1 }, prompts: { $sum: { $cond: [{ $ne: ['$submittedAt', null] }, 1, 0] } },
      averageLength: { $avg: '$promptLength' }, averageDurationMs: { $avg: '$durationMs' }, completed: { $sum: { $cond: [{ $ne: ['$durationMs', null] }, 1, 0] } },
      sessions: { $addToSet: { device: '$deviceId', session: '$sessionId' } }, incomplete: { $sum: { $cond: [{ $eq: ['$durationMs', null] }, 1, 0] } } } }],
    daily: [{ $match: { submittedAt: { $ne: null } } }, { $group: { _id: { $dateToString: { date: '$submittedAt', format: '%Y-%m-%d', timezone: q.timezone } },
      prompts: { $sum: 1 }, averageDurationMs: { $avg: '$durationMs' }, completed: { $sum: { $cond: [{ $ne: ['$durationMs', null] }, 1, 0] } } } }, { $sort: { _id: 1 } }],
    lengths: [{ $match: { promptLength: { $ne: null } } }, { $bucket: { groupBy: '$promptLength', boundaries: [0, 100, 500, 2000, 10000001], default: 'other', output: { prompts: { $sum: 1 } } } }],
    projects: [{ $match: { project: { $ne: '' } } }, { $group: { _id: '$project', prompts: { $sum: { $cond: [{ $ne: ['$submittedAt', null] }, 1, 0] } } } }, { $sort: { _id: 1 } }],
  } }]).option({ maxTimeMS: 10000 });
  const stat = result.stats[0];
  return res.json({ rows: await namedRows(result.rows.slice(0, limit)), page, hasMore: result.rows.length > limit,
    stats: { records: stat?.records ?? 0, prompts: stat?.prompts ?? 0, sessions: stat?.sessions.length ?? 0,
      averageLength: stat?.averageLength ?? null, averageDurationMs: stat?.averageDurationMs ?? null, completed: stat?.completed ?? 0, incomplete: stat?.incomplete ?? 0 },
    daily: result.daily, lengths: result.lengths, projects: result.projects,
    period: { from: q.from, to: q.to, timezone: q.timezone }, retentionDays: historyRetentionDays(), generatedAt: new Date() });
}));

historyRouter.get('/diagnostics', route(async (_req, res) => {
  const devices = await Device.find().populate('personId', 'name').select('name personId revokedAt archivedAt promptCollectionEnabled lastReportAt lastHistoryReportAt historySetupVersion historyPlatform historyPendingCount historyDroppedCount').sort({ name: 1 }).limit(501).lean();
  return res.json({ devices: devices.slice(0, 500), truncated: devices.length > 500, requiredSetupVersion: '2.0.0', retentionDays: historyRetentionDays(), generatedAt: new Date() });
}));

historyRouter.get('/export.csv', route(async (req, res) => {
  const q = filters(req.query);
  const records = await PromptTurn.aggregate([...basePipeline(q), { $sort: { submittedAt: 1, _id: 1 } }, { $limit: 10001 }, { $project: { ...rowProjection, promptText: 1 } }]).option({ maxTimeMS: 10000 });
  if (records.length > 10000) return res.status(413).json({ error: 'Choose a smaller period; prompt export is limited to 10,000 records.' });
  const rows = await namedRows(records);
  res.type('text/csv'); res.setHeader('Content-Disposition', 'attachment; filename="prompt-history.csv"');
  return res.send(['submittedAtUtc,completedAtUtc,device,assignedPerson,sessionId,promptId,project,promptLength,observedDurationMs,truncated,userPrompt', ...rows.map(r =>
    [r.submittedAt?.toISOString(), r.completedAt?.toISOString(), r.deviceName, r.personName, r.sessionId, r.promptId, r.project, r.promptLength, r.durationMs, r.truncated, r.promptText].map(csvCell).join(','))].join('\r\n'));
}));

historyRouter.get('/sessions/:deviceId/:sessionId', route(async (req, res) => {
  const q = filters({ ...req.query, deviceId: req.params.deviceId, sessionId: req.params.sessionId }), page = pageNumber(req.query);
  const device = await Device.findById(req.params.deviceId).select('name promptCollectionEnabled lastHistoryReportAt').lean();
  if (!device) return res.status(404).json({ error: 'Device not found.' });
  const [result] = await PromptTurn.aggregate([...basePipeline(q), { $facet: {
    rows: [{ $sort: { submittedAt: 1, _id: 1 } }, { $skip: page * 25 }, { $limit: 26 }, { $project: { ...rowProjection, promptText: 1 } }], count: [{ $count: 'value' }],
  } }]).option({ maxTimeMS: 10000 });
  const tag = await SessionProject.findOne({ deviceId: device._id, sessionId: req.params.sessionId }).lean();
  return res.json({ device, project: tag?.project ?? '', rows: await namedRows(result.rows.slice(0, 25)), page, hasMore: result.rows.length > 25,
    total: result.count[0]?.value ?? 0, retentionDays: historyRetentionDays(), period: { from: q.from, to: q.to, timezone: q.timezone } });
}));

historyRouter.patch('/sessions/:deviceId/:sessionId', route(async (req, res) => {
  const body = z.object({ project: z.string().trim().max(80) }).strict().safeParse(req.body);
  if (!body.success) return res.status(400).json({ error: 'Provide a project tag of up to 80 characters.' });
  const result = await transaction(async session => {
    const device = await lockDevice(req.params.deviceId, session), filter = { deviceId: device._id, sessionId: req.params.sessionId };
    if (!await PromptTurn.exists(filter).session(session) && !await UsageRecord.exists(filter).session(session)) return fail(404, 'No recorded session found.');
    return SessionProject.findOneAndUpdate(filter, { $set: body.data }, { upsert: true, new: true, runValidators: true, session });
  });
  return res.json({ project: result?.project ?? '' });
}));

historyRouter.delete('/prompts/:promptId', route(async (req, res) => {
  if (req.body?.confirmation !== 'DELETE PROMPT') return res.status(409).json({ error: 'Confirm permanent prompt deletion.' });
  await transaction(async session => {
    const row = await PromptTurn.findById(req.params.promptId).session(session);
    if (!row) return fail(404, 'Prompt not found.');
    await lockDevice(String(row.deviceId), session);
    await erasePromptRows([row], session);
  });
  return res.status(204).end();
}));
