import type { NextFunction, Request, Response } from 'express';
import { AUTH_COOKIE_NAME } from '../lib/authCookie';
import { verifyAuthToken } from '../services/jwt';
import { sendError } from '../lib/apiError';

export interface AuthenticatedUser {
  id: string;
  role: string;
  agencyId?: string;
}

declare module 'express-serve-static-core' {
  interface Request {
    authUser?: AuthenticatedUser;
  }
}

export function requireAuth(req: Request, res: Response, next: NextFunction) {
  const token = req.cookies?.[AUTH_COOKIE_NAME];
  const payload = typeof token === 'string' ? verifyAuthToken(token) : null;

  if (!payload) {
    return sendError(res, 401, 'UNAUTHENTICATED', 'ログインが必要です');
  }

  req.authUser = { id: payload.sub, role: payload.role, agencyId: payload.agencyId };
  next();
}

export function requireAdmin(req: Request, res: Response, next: NextFunction) {
  requireAuth(req, res, () => {
    if (req.authUser?.role !== 'admin') {
      return sendError(res, 403, 'FORBIDDEN', '管理者のみ利用できます');
    }
    next();
  });
}

export function requireAgency(req: Request, res: Response, next: NextFunction) {
  requireAuth(req, res, () => {
    if (req.authUser?.role !== 'agency' || !req.authUser.agencyId) {
      return sendError(res, 403, 'FORBIDDEN', '代理店アカウントのみ利用できます');
    }
    next();
  });
}
