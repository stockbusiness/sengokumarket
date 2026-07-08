import { Router } from 'express';
import { sendError } from '../lib/apiError';
import { HttpError } from '../lib/httpError';
import { syncAgencyHierarchyFromExternalSystem } from '../services/agencyHierarchySync';
import { expireOverdueBankTransferOrders } from '../services/bankTransfer';

const router = Router();

// 仕様書外の拡張: Vercel Cronから日次で呼び出し、外部代理店システムの階層を同期する。
router.get('/sync-agency-hierarchy', async (_req, res) => {
  try {
    const result = await syncAgencyHierarchyFromExternalSystem();
    res.json(result);
  } catch (e) {
    if (e instanceof HttpError) return sendError(res, e.status, e.code, e.message);
    throw e;
  }
});

// 仕様書外の拡張: Vercel Cronから日次で呼び出し、振込期限を過ぎた未入金の銀行振込注文を失効させる。
router.get('/expire-bank-transfer-orders', async (_req, res) => {
  try {
    const result = await expireOverdueBankTransferOrders();
    res.json(result);
  } catch (e) {
    if (e instanceof HttpError) return sendError(res, e.status, e.code, e.message);
    throw e;
  }
});

export default router;
