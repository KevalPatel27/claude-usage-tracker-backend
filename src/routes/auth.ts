import { route } from '../lib/route.js';
/**
 * Admin authentication routes.
 * JWT-based sessions with HTTP-only cookies.
 */

import { Router, Request, Response } from 'express';
import jwt from 'jsonwebtoken';
import { Admin } from '../models/index.js';
import { hashPassword, verifyPassword } from '../lib/crypto.js';
import { requireAdmin } from '../middleware/auth.js';

export const authRouter = Router();

const JWT_SECRET = process.env.JWT_SECRET!;
const JWT_EXPIRES_IN = '8h';
const COOKIE_NAME = 'admin_token';

function signToken(adminId: string): string {
  return jwt.sign({ sub: adminId, role: 'admin' }, JWT_SECRET, {
    expiresIn: JWT_EXPIRES_IN,
  });
}

function setCookie(res: Response, token: string): void {
  res.cookie(COOKIE_NAME, token, {
    httpOnly: true,
    secure: process.env.NODE_ENV === 'production',
    sameSite: 'strict',
    maxAge: 8 * 60 * 60 * 1000, // 8h in ms
    path: '/',
  });
}

// Bootstrap: create first admin (requires ADMIN_BOOTSTRAP_SECRET env var)
authRouter.post('/bootstrap', route(async (req: Request, res: Response) => {
  const { bootstrapSecret, username, password } = req.body;

  if (
    !bootstrapSecret ||
    bootstrapSecret !== process.env.ADMIN_BOOTSTRAP_SECRET
  ) {
    return res.status(403).json({ error: 'Invalid bootstrap secret' });
  }

  const existing = await Admin.countDocuments();
  if (existing > 0) {
    return res.status(409).json({ error: 'Admin account already exists. Use /api/auth/login.' });
  }

  if (typeof username !== 'string' || typeof password !== 'string' || password.length < 12 || Buffer.byteLength(password) > 72) {
    return res.status(400).json({
      error: 'Username and password required. Password must be at least 12 characters.',
    });
  }

  const passwordHash = await hashPassword(password);
  const admin = await Admin.create({ _id: '000000000000000000000001', username, passwordHash });

  const token = signToken(admin._id.toHexString());
  setCookie(res, token);

  return res.status(201).json({ message: 'Admin created', username: admin.username });
}));

// Login
authRouter.post('/login', route(async (req: Request, res: Response) => {
  const { username, password } = req.body;
  if (typeof username !== 'string' || typeof password !== 'string' || Buffer.byteLength(password) > 72) {
    return res.status(400).json({ error: 'Username and password required' });
  }

  const admin = await Admin.findOne({ username: username.toLowerCase() });
  if (!admin) {
    return res.status(401).json({ error: 'Invalid credentials' });
  }

  const valid = await verifyPassword(password, admin.passwordHash);
  if (!valid) {
    return res.status(401).json({ error: 'Invalid credentials' });
  }

  const token = signToken(admin._id.toHexString());
  setCookie(res, token);

  return res.json({ message: 'Logged in', username: admin.username });
}));

// Logout
authRouter.post('/logout', route((_req: Request, res: Response) => {
  res.clearCookie(COOKIE_NAME, { path: '/' });
  return res.json({ message: 'Logged out' });
}));

// Session check
authRouter.get('/me', requireAdmin, route(async (req: Request, res: Response) => {
  return res.json({ adminId: (req as any).adminId });
}));
