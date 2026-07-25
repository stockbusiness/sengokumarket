import { Router } from 'express';
import { requireAdmin, restrictAdminViewerToReadOnly, forbidStaff } from '../../middleware/auth';
import { auditLog } from '../../middleware/auditLog';
import auditLogsRouter from './auditLogs';
import adminUsersRouter from './adminUsers';
import dashboardRouter from './dashboard';
import productsRouter from './products';
import productIntegrationRulesRouter from './productIntegrationRules';
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
import orderLinkingJobsRouter from './orderLinkingJobs';
import integrationPreflightRouter from './integrationPreflight';
import orderWalletTransactionsRouter from './orderWalletTransactions';
import walletClaimsRouter from './walletClaims';
import collectibleDeliveriesRouter from './collectibleDeliveries';

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
router.use(orderLinkingJobsRouter);
router.use(orderWalletTransactionsRouter);
// 戦国マーケット NFTカード受取・送付 実装指示書(2026-07-25)19章: Wallet Claims・
// Collectible Deliveriesは外部連携の運用・監視系のため、他の千ノ国連携画面と同様staffには公開しない。
router.use(walletClaimsRouter);
router.use(collectibleDeliveriesRouter);
// 本番安定化指示書Stage6: 商品ごとの権利付与ルーティング・OVEポイント計算設定は、日次業務
// (在庫・注文対応等)ではなく代理店設定等と同様の高度な設定操作のため、staffには公開しない。
router.use(productIntegrationRulesRouter);
router.use(integrationPreflightRouter);

export default router;
