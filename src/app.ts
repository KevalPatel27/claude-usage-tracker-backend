import { QueryError } from './lib/query.js';
import { ManagementError } from './lib/management.js';
import 'dotenv/config';
import express from 'express';
import helmet from 'helmet';
import cors from 'cors';
import cookieParser from 'cookie-parser';
import rateLimit from 'express-rate-limit';
import mongoose from 'mongoose';

import { historyRouter, historyIngestRouter } from './routes/history.js';
import { otlpRouter } from './routes/otlp.js';
import { authRouter } from './routes/auth.js';
import { devicesRouter } from './routes/devices.js';
import { peopleRouter } from './routes/people.js';
import { dashboardRouter } from './routes/dashboard.js';

const app = express();
app.set('trust proxy', 1);
const PORT = parseInt(process.env.PORT ?? '4000', 10);

// ─── Security headers ──────────────────────────────────────────────────────────
app.use(helmet({
  crossOriginResourcePolicy: { policy: 'cross-origin' },
}));

// ─── CORS ─────────────────────────────────────────────────────────────────────
const allowedOrigins = (process.env.ALLOWED_ORIGINS ?? 'http://localhost:3000')
  .split(',')
  .map(o => o.trim())
  .filter(Boolean);

app.use(cors({
  origin: (origin, callback) => {
    // Allow no-origin requests (Render health checks, curl)
    if (!origin || allowedOrigins.includes(origin)) {
      callback(null, true);
    } else {
      callback(new Error(`CORS: origin ${origin} not allowed`));
    }
  },
  credentials: true,
  methods: ['GET', 'POST', 'PATCH', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'X-Tracker-Key'],
}));

// ─── Body parsing ──────────────────────────────────────────────────────────────
// OTLP payloads can be larger; cap at 2MB
app.use(express.json({ limit: '2mb' }));
app.use(cookieParser());

// ─── Rate limiting ─────────────────────────────────────────────────────────────
const otlpLimiter = rateLimit({
  windowMs: 60_000,
  max: 120,  // OTLP default export interval is 60s; allow bursts of 2/s
  message: { error: 'Too many ingestion requests' },
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: (req) => {
    // Rate limit by tracker key prefix to allow multiple devices from same IP
    const key = req.headers['x-tracker-key'];
    return typeof key === 'string' ? key.substring(0, 16) : req.ip ?? 'unknown';
  },
});

const apiLimiter = rateLimit({
  windowMs: 60_000,
  max: 200,
  message: { error: 'Too many requests' },
  standardHeaders: true,
  legacyHeaders: false,
});

// ─── Routes ────────────────────────────────────────────────────────────────────
app.use('/v1', otlpLimiter, otlpRouter, historyIngestRouter);
app.use('/api', (req, res, next) => {
  if (!['GET', 'HEAD', 'OPTIONS'].includes(req.method) && req.headers.origin && !allowedOrigins.includes(req.headers.origin)) return res.status(403).json({ error: 'Origin not allowed' });
  next();
});
app.use('/api/auth', rateLimit({ windowMs: 15 * 60_000, max: 30, skip: req => req.method === 'GET', standardHeaders: true, legacyHeaders: false }), apiLimiter, authRouter);
app.use('/api/devices', apiLimiter, devicesRouter);
app.use('/api/people', apiLimiter, peopleRouter);
app.use('/api/dashboard', apiLimiter, dashboardRouter);
app.use('/api/history', apiLimiter, historyRouter);

// Health check (no auth — used by Render)
app.get('/health', (_req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  const dbState = mongoose.connection.readyState;
  res.status(dbState === 1 ? 200 : 503).json({
    status: dbState === 1 ? 'ok' : 'degraded',
    db: dbState,
    uptime: process.uptime(),
  });
});

// ─── 404 handler ──────────────────────────────────────────────────────────────
app.use((_req, res) => {
  res.status(404).json({ error: 'Not found' });
});

// ─── Error handler ─────────────────────────────────────────────────────────────
app.use((err: Error, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
  if (!(err instanceof ManagementError) && !(err instanceof QueryError)) console.error('[ERROR]', err.name);
  const status = (err as Error & { status?: number }).status;
  const httpStatus = status && status >= 400 && status < 500 ? status : 500;
  if (_req.path === '/v1/metrics') { res.status(httpStatus).json({ code: httpStatus === 400 ? 3 : httpStatus === 413 ? 8 : 13, message: 'Request failed' }); return; }
  res.status(httpStatus).json({ error: err instanceof ManagementError || err instanceof QueryError ? err.message : 'Request failed' });
});

// ─── MongoDB connection ────────────────────────────────────────────────────────

export { app };
