import { Router } from 'express';
import { Device } from '../models/index.js';
import { verifyDeviceKey } from '../lib/crypto.js';
import { parseOtlpMetricsPayload } from '../lib/otlp-parser.js';
import { CounterConflict, ingestDataPoints } from '../lib/ingestion.js';
export const otlpRouter = Router();
otlpRouter.post('/metrics', async (req, res) => {
  try {
    const key = req.headers['x-tracker-key'];
    if (typeof key !== 'string' || !/^dkey_[a-f0-9]{64}$/.test(key)) return res.status(401).json({ code: 16, message: 'Device key required' });
    if (!req.is('application/json')) return res.status(415).json({ code: 3, message: 'Use OTLP HTTP/JSON' });
    const candidates = await Device.find({ revokedAt: null, archivedAt: null, keyPrefix: key.slice(5,13) }).lean();
    let device = null;
    for (const candidate of candidates) if (await verifyDeviceKey(key, candidate.keyHash)) { device = candidate; break; }
    if (!device) return res.status(401).json({ code: 16, message: 'Invalid or revoked device key' });
    let payloads;
    try { payloads = parseOtlpMetricsPayload(req.body); }
    catch { return res.status(400).json({ code: 3, message: 'Invalid OTLP token metric payload' }); }
    await ingestDataPoints(device._id, device.personId, payloads.flatMap(p => p.dataPoints));
    return res.status(200).json({});
  } catch (err) {
    if (err instanceof CounterConflict) return res.status(400).json({ code: 3, message: err.message });
    // OTLP clients must retry transient failures. Partial success MUST NOT be used for DB failures.
    res.setHeader('Retry-After', '5');
    return res.status(503).json({ code: 14, message: 'Persistence unavailable; retry report' });
  }
});
