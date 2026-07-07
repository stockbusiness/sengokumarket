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

const ADMIN_ROLES = ['admin', 'admin_viewer'];

// 仕様書外の拡張: 管理者権限を「admin(通常)」「admin_viewer(閲覧専用)」に分ける。
// 閲覧専用アカウントも管理画面自体へのアクセスは許可し、書き込み系操作は
// restrictAdminViewerToReadOnlyで一括して弾く(ルート個別にチェックを書かない)。
export function requireAdmin(req: Request, res: Response, next: NextFunction) {
  requireAuth(req, res, () => {
    if (!ADMIN_ROLES.includes(req.authUser?.role ?? '')) {
      return sendError(res, 403, 'FORBIDDEN', '管理者のみ利用できます');
    }
    next();
  });
}

export function restrictAdminViewerToReadOnly(req: Request, res: Response, next: NextFunction) {
  if (req.authUser?.role === 'admin_viewer' && req.method !== 'GET') {
    return sendError(res, 403, 'READONLY_ADMIN', '閲覧専用アカウントのため、この操作はできません');
  }
  next();
}

export function requireAgency(req: Request, res: Response, next: NextFunction) {
  requireAuth(req, res, () => {
    if (req.authUser?.role !== 'agency' || !req.authUser.agencyId) {
      return sendError(res, 403, 'FORBIDDEN', '代理店アカウントのみ利用できます');
    }
    next();
  });
}
