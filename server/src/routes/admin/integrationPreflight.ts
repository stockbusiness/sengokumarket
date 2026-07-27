import { Router } from 'express';
import { sendError } from '../../lib/apiError';
import { buildIntegrationPreflightReport } from '../../services/integrationPreflight';
import { buildWalletClaimPreflightReport } from '../../services/walletClaimPreflight';
import {
  getSennokuniIntegrationStage,
  setSennokuniIntegrationStageSetting,
  SENNOKUNI_INTEGRATION_STAGES,
} from '../../services/sennokuniIntegrationConfig';

const router = Router();

// 本番安定化指示書Stage8(11.3「Preflight」): Feature Flag・必須設定・URL/path形式・
// HMAC自己診断・送信先connection test・backlog/dead/blocked件数・product rule件数を
// 1回の呼び出しでまとめて確認できるようにする。
router.get('/integration-preflight', async (_req, res) => {
  const report = await buildIntegrationPreflightReport();
  res.json({ report });
});

router.get('/integration-stage', async (_req, res) => {
  const stage = await getSennokuniIntegrationStage();
  res.json({ stage });
});

// 本番安定化指示書Stage8(11.5「正式設定不足でproduction有効化不可」「HMAC test vector
// 不合格で有効化不可」): staging/productionへの変更前に必ずpreflightを再実行し、
// readyForActivationがfalseなら拒否する。dry_runへの変更(引き下げ)は常に許可する
// (安全側への変更をブロックする理由がないため)。この操作は他の管理APIと同様、
// admin/index.tsのauditLogミドルウェアにより自動的に監査ログへ記録される(11.5)。
router.put('/integration-stage', async (req, res) => {
  const stage = (req.body ?? {}).stage;
  if (typeof stage !== 'string' || !(SENNOKUNI_INTEGRATION_STAGES as readonly string[]).includes(stage)) {
    return sendError(res, 400, 'VALIDATION_ERROR', `stageはdry_run/staging/productionのいずれかを指定してください`);
  }

  if (stage === 'staging' || stage === 'production') {
    const report = await buildIntegrationPreflightReport();
    if (!report.readyForActivation) {
      return sendError(
        res,
        422,
        'PREFLIGHT_NOT_READY',
        '必須設定の不足・形式不正・HMAC自己診断の失敗があるため、この段階へは変更できません。GET /api/admin/integration-preflightで詳細を確認してください',
      );
    }

    // Wallet Claim本番前安定化指示書(2026-07-25)Phase8(10.4「production有効化前にfail-close」)・
    // 最終安定化指示書Phase3「production切替ゲート」: digital_collectible向けの有効なルールが
    // 存在する場合、walletClaimReport.overallReady===trueを必須にする(カード送付固有の必須設定・
    // ルール整合性・dead/blocked滞留・migration状態をすべて含む)。
    const walletClaimReport = await buildWalletClaimPreflightReport();
    if (walletClaimReport.enabledDigitalCollectibleRuleCount > 0 && !walletClaimReport.overallReady) {
      return sendError(
        res,
        422,
        'WALLET_CLAIM_PREFLIGHT_NOT_READY',
        'digital_collectible向けの有効なルールがありますが、カード送付固有の必須設定・整合性チェックが不足しているためこの段階へは変更できません。GET /api/admin/wallet-claim-preflightで詳細を確認してください',
      );
    }
  }

  await setSennokuniIntegrationStageSetting(stage as 'dry_run' | 'staging' | 'production');
  const updatedStage = await getSennokuniIntegrationStage();
  res.json({ stage: updatedStage });
});

export default router;
