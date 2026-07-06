import { Router } from 'express';
import { requireAgency } from '../../middleware/auth';
import referralLinksRouter from './referralLinks';

const router = Router();

// 代理店ポータルは自代理店の紹介URL発行・一覧のみ提供する(仕様書外の拡張)。
router.use(requireAgency);
router.use(referralLinksRouter);

export default router;
