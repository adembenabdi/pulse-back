import type { Request, Response, NextFunction } from 'express';
import { logger } from '../lib/logger.js';

export function requestLogger(req: Request, _res: Response, next: NextFunction): void {
  logger.debug({ method: req.method, path: req.path }, 'incoming request');
  next();
}
