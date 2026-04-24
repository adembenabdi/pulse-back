import type { Request, Response, NextFunction } from 'express';
import { verifyAccessToken } from '../lib/jwt.js';
import { AppError } from './error.js';
import { db } from '../lib/db.js';

export interface AuthUser {
  id: string;
  email: string;
  name: string;
  timezone: string;
}

// Extend Express Request
declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      user: AuthUser;
      db: ReturnType<typeof db.scoped>;
      dbShared: ReturnType<typeof db.shared>;
    }
  }
}

export async function requireAuth(
  req: Request,
  _res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const header = req.headers.authorization;
    if (!header?.startsWith('Bearer ')) {
      return next(new AppError(401, 'Missing authorization header'));
    }

    const token = header.slice(7);
    const payload = verifyAccessToken(token);

    // Lightweight user fetch — just enough to populate req.user
    const result = await db.admin.query<{ id: string; email: string; name: string; timezone: string }>(
      `SELECT id, email, name,
              COALESCE(preferences->>'timezone', 'Africa/Algiers') AS timezone
       FROM users
       WHERE id = $1 AND deleted_at IS NULL`,
      [payload.sub],
    );

    if (result.rows.length === 0) {
      return next(new AppError(401, 'User not found'));
    }

    const user = result.rows[0]!;
    req.user = user;
    req.db = db.scoped(user.id);
    req.dbShared = db.shared(user.id);

    next();
  } catch (err) {
    next(err);
  }
}
