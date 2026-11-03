import { Request, Response, NextFunction, RequestHandler } from 'express';
export const route = (fn: (req: Request, res: Response, next: NextFunction) => unknown): RequestHandler =>
  (req, res, next) => { Promise.resolve().then(() => fn(req, res, next)).catch(next); };
