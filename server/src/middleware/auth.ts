import type { NextFunction, Request, Response } from 'express';
import { AUTH_COOKIE_NAME } from '../lib/authCookie';
import { verifyAuthToken } from '../services/jwt';
import { sendError } from '../lib/apiError';
import { prisma } from '../lib/prisma';
import { ADMIN_ROLES } from '@sengoku/contracts';

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

// 残課題指示書Stage11: JWTはCookieの有効期間中(7日)ずっと有効なままなので、role変更・
// agencyId変更・パスワード変更・アカウント停止・強制ログアウトを即座に反映できない。
// トークンの検証だけで済ませず、リクエストごとにDBの最新状態と照合し、発行時点から
// 何か変わっていれば旧Cookieを無効化する。
export async function requireAuth(req: Request, res: Response, next: NextFunction) {
  const token = req.cookies?.[AUTH_COOKIE_NAME];
  const payload = typeof token === 'string' ? verifyAuthToken(token) : null;

  if (!payload) {
    return sendError(res, 401, 'UNAUTHENTICATED', 'ログインが必要です');
  }

  let user;
  try {
    user = await prisma.user.findUnique({ where: { id: payload.sub }, include: { agency: true } });
  } catch (e) {
    console.error('requireAuth: セッション確認のためのDB照合に失敗しました', e);
    return sendError(res, 500, 'INTERNAL_ERROR', '認証確認に失敗しました');
  }

  if (!user) {
    return sendError(res, 401, 'SESSION_REVOKED', 'セッションが無効になりました。再度ログインしてください');
  }

  // agencyIdが実際に設定されている場合のみ、その代理店のstatusを照合する
  // (role='agency'でもagencyId未設定の異常系ではagency自体が存在しないため対象外)。
  const sessionStillValid =
    user.role === payload.role &&
    (user.agencyId ?? undefined) === payload.agencyId &&
    user.sessionVersion === payload.sessionVersion &&
    (!user.agencyId || user.agency?.status === 'active');

  if (!sessionStillValid) {
    return sendError(res, 401, 'SESSION_REVOKED', 'セッションが無効になりました。再度ログインしてください');
  }

  req.authUser = { id: user.id, role: user.role, agencyId: user.agencyId ?? undefined };
  next();
}

// 仕様書外の拡張: 管理者権限を「admin(通常)」「admin_viewer(閲覧専用)」「staff(日次業務のみ)」に分ける。
// いずれも管理画面自体へのアクセスは許可し、書き込み系操作の制限はrestrictAdminViewerToReadOnly、
// staffが利用できない機能の制限はforbidStaffで一括して弾く(ルート個別にチェックを書かない)。
export function requireAdmin(req: Request, res: Response, next: NextFunction) {
  requireAuth(req, res, () => {
    if (!(ADMIN_ROLES as readonly string[]).includes(req.authUser?.role ?? '')) {
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

// 仕様書外の拡張: staff(スタッフ)は注文・NFT発行・商品・お知らせ等の日次業務のみ利用でき、
// 管理者アカウント管理・決済/メール設定・監査ログ・紹介リンク発行・クーポン管理・代理店関連機能は
// 利用できない。admin/index.tsでスタッフに公開しないルーター群の手前にのみ挟む。
export function forbidStaff(req: Request, res: Response, next: NextFunction) {
  if (req.authUser?.role === 'staff') {
    return sendError(res, 403, 'FORBIDDEN', 'スタッフアカウントはこの機能を利用できません');
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
