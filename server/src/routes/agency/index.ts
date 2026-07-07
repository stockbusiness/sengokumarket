import { Router } from 'express';
import { requireAgency } from '../../middleware/auth';
import { auditLog } from '../../middleware/auditLog';
import referralLinksRouter from './referralLinks';
import ordersRouter from './orders';

const router = Router();

// 代理店ポータルは自代理店の紹介URL発行・一覧・紹介経由の購入者一覧のみ提供する(仕様書外の拡張)。
router.use(requireAgency);
// 状態変更操作(GET以外)の監査ログを一括で記録する(仕様書外の拡張)。
router.use(auditLog);
router.use(referralLinksRouter);
router.use(ordersRouter);

export default router;
