import { Router } from 'express';
import { requireAdmin, restrictAdminViewerToReadOnly } from '../../middleware/auth';
import { auditLog } from '../../middleware/auditLog';
import auditLogsRouter from './auditLogs';
import adminUsersRouter from './adminUsers';
import dashboardRouter from './dashboard';
import productsRouter from './products';
import ordersRouter from './orders';
import nftIssuesRouter from './nftIssues';
import walletMissingRouter from './walletMissing';
import noticesRouter from './notices';
import agenciesRouter from './agencies';
import referralLinksRouter from './referralLinks';
import referralsRouter from './referrals';
import settingsRouter from './settings';
import bankTransferSettingsRouter from './bankTransferSettings';
import importProductsRouter from './importProducts';
import legalRouter from './legal';
import couponsRouter from './coupons';

const router = Router();

// 管理APIは認可ミドルウェアで一括保護する(ルート個別にチェックを書かない。仕様書v1.5コーディング規約)。
router.use(requireAdmin);
// 状態変更操作(GET以外)の監査ログを一括で記録する(仕様書外の拡張)。
router.use(auditLog);
// 閲覧専用アカウント(admin_viewer)はGET以外を一括で拒否する(仕様書外の拡張)。
router.use(restrictAdminViewerToReadOnly);

router.use(auditLogsRouter);
router.use(adminUsersRouter);
router.use(dashboardRouter);
router.use(productsRouter);
router.use(ordersRouter);
router.use(nftIssuesRouter);
router.use(walletMissingRouter);
router.use(noticesRouter);
router.use(agenciesRouter);
router.use(referralLinksRouter);
router.use(referralsRouter);
router.use(settingsRouter);
router.use(bankTransferSettingsRouter);
router.use(importProductsRouter);
router.use(legalRouter);
router.use(couponsRouter);

export default router;
