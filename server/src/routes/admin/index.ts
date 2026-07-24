import { Router } from 'express';
import { requireAdmin, restrictAdminViewerToReadOnly, forbidStaff } from '../../middleware/auth';
import { auditLog } from '../../middleware/auditLog';
import auditLogsRouter from './auditLogs';
import adminUsersRouter from './adminUsers';
import dashboardRouter from './dashboard';
import productsRouter from './products';
import ordersRouter from './orders';
import externalOrdersRouter from './externalOrders';
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
import stripeEventsRouter from './stripeEvents';
import integrationOutboxRouter from './integrationOutbox';
import notificationOutboxRouter from './notificationOutbox';

const router = Router();

// 管理APIは認可ミドルウェアで一括保護する(ルート個別にチェックを書かない。仕様書v1.5コーディング規約)。
router.use(requireAdmin);
// 状態変更操作(GET以外)の監査ログを一括で記録する(仕様書外の拡張)。
router.use(auditLog);
// 閲覧専用アカウント(admin_viewer)はGET以外を一括で拒否する(仕様書外の拡張)。
router.use(restrictAdminViewerToReadOnly);

// スタッフ(staff)も利用できる日次業務系(仕様書外の拡張)。
router.use(dashboardRouter);
router.use(productsRouter);
router.use(importProductsRouter);
router.use(ordersRouter);
router.use(externalOrdersRouter);
router.use(nftIssuesRouter);
router.use(walletMissingRouter);
router.use(noticesRouter);

// ここから先はスタッフには公開しない(管理者・閲覧専用管理者のみ)。
router.use(forbidStaff);
router.use(auditLogsRouter);
router.use(adminUsersRouter);
router.use(agenciesRouter);
router.use(referralLinksRouter);
router.use(referralsRouter);
router.use(settingsRouter);
router.use(bankTransferSettingsRouter);
router.use(legalRouter);
router.use(couponsRouter);
router.use(stripeEventsRouter);
router.use(integrationOutboxRouter);
router.use(notificationOutboxRouter);

export default router;
