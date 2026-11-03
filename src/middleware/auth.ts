/**
 * Authentication middleware for dashboard routes.
 * Verifies JWT from HTTP-only cookie.
 * Device keys NEVER pass through this middleware.
 */

import { Request, Response, NextFunction } from 'express';
import jwt from 'jsonwebtoken';

const JWT_SECRET = process.env.JWT_SECRET!;
const COOKIE_NAME = 'admin_token';

export function requireAdmin(req: Request, res: Response, next: NextFunction): void {
  const token = req.cookies?.[COOKIE_NAME];
  if (!token) {
    res.status(401).json({ error: 'Not authenticated' });
    return;
  }

  try {
    const payload = jwt.verify(token, JWT_SECRET, { algorithms: ['HS256'] }) as { sub: string; role: string };
    if (payload.role !== 'admin') {
      res.status(403).json({ error: 'Forbidden' });
      return;
    }
    (req as any).adminId = payload.sub;
    next();
  } catch {
    res.status(401).json({ error: 'Invalid or expired session' });
  }
}
