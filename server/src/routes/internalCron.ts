import { Router } from 'express';
import type { Request } from 'express';
import { sendError } from '../lib/apiError';
import { HttpError } from '../lib/httpError';
import { syncAgencyHierarchyFromExternalSystem } from '../services/agencyHierarchySync';
import { expireOverdueBankTransferOrders } from '../services/bankTransfer';
import { processNftMints } from '../services/nftMintProcessing';
import { dispatchPendingOutboxEvents } from '../services/integrationOutboxDispatcher';
import { dispatchPendingNotifications } from '../modules/notifications/application/dispatchNotificationOutbox.usecase';
import { processOrderLinkingJobs } from '../services/orderLinkingJobDispatcher';
import { cleanupStaleRateLimitBuckets } from '../services/rateLimiter';
import { cleanupWalletClaimApiNonces } from '../middleware/walletClaimHmac';
import { withSchedulerHeartbeat } from '../services/schedulerHeartbeat';

const router = Router();

// 最終安定化指示書Phase7「Scheduler主系/予備系整理」: Vercel Cron・GitHub Actions Cron双方に
// 呼び出しURLへ?source=vercel / ?source=github-actions を付与してもらい、どちらが実際に
// ジョブを実行できているかをjob_scheduler_heartbeatsへ記録できるようにする。未指定(手動実行等)は
// 'manual'として記録する。
function getSchedulerSource(req: Request): string {
  const source = req.query.source;
  return typeof source === 'string' && source.length > 0 ? source : 'manual';
}

// 仕様書外の拡張: Vercel Cronから日次で呼び出し、外部代理店システムの階層を同期する。
router.get('/sync-agency-hierarchy', async (req, res) => {
  try {
    const result = await withSchedulerHeartbeat('sync-agency-hierarchy', getSchedulerSource(req), () =>
      syncAgencyHierarchyFromExternalSystem(),
    );
    res.json(result);
  } catch (e) {
    if (e instanceof HttpError) return sendError(res, e.status, e.code, e.message);
    throw e;
  }
});

// 仕様書外の拡張: Vercel Cronから日次で呼び出し、振込期限を過ぎた未入金の銀行振込注文を失効させる。
router.get('/expire-bank-transfer-orders', async (req, res) => {
  try {
    const result = await withSchedulerHeartbeat('expire-bank-transfer-orders', getSchedulerSource(req), () =>
      expireOverdueBankTransferOrders(),
    );
    res.json(result);
  } catch (e) {
    if (e instanceof HttpError) return sendError(res, e.status, e.code, e.message);
    throw e;
  }
});

// 仕様書外の拡張: NFT自動発行(外部Mint API連携)。決済完了直後にもベストエフォートで
// 呼ばれるが(orderFulfillment経由)、失敗時の再試行・取りこぼしのセーフティネットとして
// cronからも定期実行する。
// 最終安定化指示書Phase7: GitHub Actions Cron(5分間隔)が主系、Vercel Cron(日次)が予備。
router.get('/process-nft-mints', async (req, res) => {
  try {
    const result = await withSchedulerHeartbeat('process-nft-mints', getSchedulerSource(req), () => processNftMints());
    res.json(result);
  } catch (e) {
    if (e instanceof HttpError) return sendError(res, e.status, e.code, e.message);
    throw e;
  }
});

// 仕様書外の拡張(千ノ国全体連携 2026-07-22指示書対応): integration_outbox_eventsの実送信
// ディスパッチャ。SENNOKUNI_INTEGRATION_ENABLED(既定OFF)が有効化されるまで、呼び出しても
// 常に全項目0のまま何もしない("Feature Flagでdormantなコード"という方針)。
// 最終安定化指示書Phase7: Vercel Cron(5分間隔)が主系、GitHub Actions Cron(20分間隔)が予備。
router.get('/process-integration-outbox', async (req, res) => {
  try {
    const result = await withSchedulerHeartbeat('process-integration-outbox', getSchedulerSource(req), () =>
      dispatchPendingOutboxEvents(),
    );
    res.json(result);
  } catch (e) {
    if (e instanceof HttpError) return sendError(res, e.status, e.code, e.message);
    throw e;
  }
});

// 残課題指示書Stage3の拡張: 代理店設定メール等のnotification_outbox_eventsディスパッチャ。
// 代理店連携API直後にもベストエフォートで呼ばれるが(triggerImmediateNotificationDispatch)、
// 失敗時の再試行・取りこぼしのセーフティネットとして cron からも定期実行する。
// 最終安定化指示書Phase7: Vercel Cron(5分間隔)が主系、GitHub Actions Cron(20分間隔)が予備。
router.get('/process-notification-outbox', async (req, res) => {
  try {
    const result = await withSchedulerHeartbeat('process-notification-outbox', getSchedulerSource(req), () =>
      dispatchPendingNotifications(),
    );
    res.json(result);
  } catch (e) {
    if (e instanceof HttpError) return sendError(res, e.status, e.code, e.message);
    throw e;
  }
});

// 残課題指示書Stage4の拡張: common_user_id解決・referral captureのorder_linking_jobs
// ディスパッチャ。checkout・会員登録直後にもベストエフォートで呼ばれるが
// (triggerImmediateOrderLinkingDispatch)、失敗時の再試行・取りこぼしのセーフティネットとして
// cronからも定期実行する。
// 最終安定化指示書Phase7: GitHub Actions Cron(5分間隔)が主系、Vercel Cron(日次)が予備。
router.get('/process-order-linking-jobs', async (req, res) => {
  try {
    const result = await withSchedulerHeartbeat('process-order-linking-jobs', getSchedulerSource(req), () =>
      processOrderLinkingJobs(),
    );
    res.json(result);
  } catch (e) {
    if (e instanceof HttpError) return sendError(res, e.status, e.code, e.message);
    throw e;
  }
});

// 本番安定化指示書Stage3(6.7): 長期間更新のないrate_limit_buckets行を掃除する。
// 日次で十分(レート制限ウィンドウ自体は分〜時間単位で、7日以上更新がなければ既に無関係)。
router.get('/cleanup-rate-limit-buckets', async (req, res) => {
  try {
    const result = await withSchedulerHeartbeat('cleanup-rate-limit-buckets', getSchedulerSource(req), () =>
      cleanupStaleRateLimitBuckets(),
    );
    res.json(result);
  } catch (e) {
    if (e instanceof HttpError) return sendError(res, e.status, e.code, e.message);
    throw e;
  }
});

// Wallet Claim本番前安定化指示書(2026-07-25)Phase2(4.5「nonce cleanup」): Claim確認APIの
// HMAC nonceは時間経過後リプレイ判定に使われなくなるため、古い行を定期削除する。
router.get('/cleanup-wallet-claim-nonces', async (req, res) => {
  try {
    const result = await withSchedulerHeartbeat('cleanup-wallet-claim-nonces', getSchedulerSource(req), () =>
      cleanupWalletClaimApiNonces(),
    );
    res.json(result);
  } catch (e) {
    if (e instanceof HttpError) return sendError(res, e.status, e.code, e.message);
    throw e;
  }
});

export default router;
