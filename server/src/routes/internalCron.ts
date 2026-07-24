import { Router } from 'express';
import { sendError } from '../lib/apiError';
import { HttpError } from '../lib/httpError';
import { syncAgencyHierarchyFromExternalSystem } from '../services/agencyHierarchySync';
import { expireOverdueBankTransferOrders } from '../services/bankTransfer';
import { processNftMints } from '../services/nftMintProcessing';
import { dispatchPendingOutboxEvents } from '../services/integrationOutboxDispatcher';
import { dispatchPendingNotifications } from '../modules/notifications/application/dispatchNotificationOutbox.usecase';

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

// 仕様書外の拡張: NFT自動発行(外部Mint API連携)。決済完了直後にもベストエフォートで
// 呼ばれるが(orderFulfillment経由)、失敗時の再試行・取りこぼしのセーフティネットとして
// cronからも定期実行する。
router.get('/process-nft-mints', async (_req, res) => {
  try {
    const result = await processNftMints();
    res.json(result);
  } catch (e) {
    if (e instanceof HttpError) return sendError(res, e.status, e.code, e.message);
    throw e;
  }
});

// 仕様書外の拡張(千ノ国全体連携 2026-07-22指示書対応): integration_outbox_eventsの実送信
// ディスパッチャ。SENNOKUNI_INTEGRATION_ENABLED(既定OFF)が有効化されるまで、呼び出しても
// 常に全項目0のまま何もしない("Feature Flagでdormantなコード"という方針)。
router.get('/process-integration-outbox', async (_req, res) => {
  try {
    const result = await dispatchPendingOutboxEvents();
    res.json(result);
  } catch (e) {
    if (e instanceof HttpError) return sendError(res, e.status, e.code, e.message);
    throw e;
  }
});

// 残課題指示書Stage3の拡張: 代理店設定メール等のnotification_outbox_eventsディスパッチャ。
// 代理店連携API直後にもベストエフォートで呼ばれるが(triggerImmediateNotificationDispatch)、
// 失敗時の再試行・取りこぼしのセーフティネットとして cron からも定期実行する。
router.get('/process-notification-outbox', async (_req, res) => {
  try {
    const result = await dispatchPendingNotifications();
    res.json(result);
  } catch (e) {
    if (e instanceof HttpError) return sendError(res, e.status, e.code, e.message);
    throw e;
  }
});

export default router;
