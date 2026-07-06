import { Router } from 'express';
import { requireAdmin } from '../../middleware/auth';
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
import importProductsRouter from './importProducts';
import legalRouter from './legal';

const router = Router();

// 管理APIは認可ミドルウェアで一括保護する(ルート個別にチェックを書かない。仕様書v1.5コーディング規約)。
router.use(requireAdmin);

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
router.use(importProductsRouter);
router.use(legalRouter);

export default router;
