import { Router } from 'express';
import { prisma } from '../../lib/prisma';
import { sendError } from '../../lib/apiError';
import { ENTITLEMENT_TARGET_SYSTEM_KEYS, REWARD_CALCULATION_MODES } from '@sengoku/contracts';

const router = Router();

// 本番安定化指示書Stage6(9.5「管理API・画面」): 商品ごとの権利付与ルーティング設定
// (product_integration_rules)を、商品編集画面から管理できるようにする。
// 1商品から複数の送信先へ設定できる(9.1・9.2「1:N化」)ため、一覧・作成・更新の3本を用意する。
// GET以外は既存のauditLogミドルウェア(admin/index.tsで一括適用)により自動的に監査ログへ
// 記録される(9.6)。

function isNonEmptyString(v: unknown): v is string {
  return typeof v === 'string' && v.trim().length > 0;
}

interface RuleInput {
  productCode?: string | null;
  entitlementTargetSystemKey?: string | null;
  entitlementType?: string | null;
  rewardRuleId?: string | null;
  rewardAmountPerUnit?: number | null;
  rewardCalculationMode?: string | null;
  revokeOnRefund?: boolean;
  requireCommonUserId?: boolean;
  requireSalesAgentId?: boolean;
  requireClosingAgentId?: boolean;
  requireReferralSessionKey?: boolean;
  enabled?: boolean;
}

function validateRuleInput(body: RuleInput): string | null {
  if (body.entitlementTargetSystemKey !== undefined && body.entitlementTargetSystemKey !== null) {
    if (!(ENTITLEMENT_TARGET_SYSTEM_KEYS as readonly string[]).includes(body.entitlementTargetSystemKey)) {
      return '送信先が不正です';
    }
  }
  if (body.rewardCalculationMode !== undefined && body.rewardCalculationMode !== null) {
    if (!(REWARD_CALCULATION_MODES as readonly string[]).includes(body.rewardCalculationMode)) {
      return 'OVEポイント計算方式が不正です';
    }
  }
  if (body.rewardAmountPerUnit !== undefined && body.rewardAmountPerUnit !== null) {
    if (!Number.isInteger(body.rewardAmountPerUnit) || body.rewardAmountPerUnit < 0) {
      return '1個当たりポイントは0以上の整数で入力してください';
    }
  }
  return null;
}

// 本番安定化指示書Stage11(14.1「Product Integration Rules」画面): 商品編集画面(9.5)は
// 1商品ずつの設定・確認だが、監視画面としては全商品を横断して連携ルールを一覧できる必要がある。
// 編集はここでは行わず、商品編集画面(9.5)への導線のみ提供する。
router.get('/product-integration-rules', async (_req, res) => {
  const rules = await prisma.productIntegrationRule.findMany({
    orderBy: { createdAt: 'desc' },
    include: { product: { select: { id: true, name: true } } },
  });
  res.json({ rules });
});

router.get('/products/:productId/integration-rules', async (req, res) => {
  const product = await prisma.product.findUnique({ where: { id: req.params.productId } });
  if (!product) return sendError(res, 404, 'PRODUCT_NOT_FOUND', '商品が見つかりません');

  const rules = await prisma.productIntegrationRule.findMany({
    where: { productId: req.params.productId },
    orderBy: { createdAt: 'asc' },
  });
  res.json({ rules });
});

router.post('/products/:productId/integration-rules', async (req, res) => {
  const product = await prisma.product.findUnique({ where: { id: req.params.productId } });
  if (!product) return sendError(res, 404, 'PRODUCT_NOT_FOUND', '商品が見つかりません');

  const body = (req.body ?? {}) as RuleInput;
  const validationError = validateRuleInput(body);
  if (validationError) return sendError(res, 400, 'VALIDATION_ERROR', validationError);

  const rule = await prisma.productIntegrationRule.create({
    data: {
      productId: product.id,
      productCode: isNonEmptyString(body.productCode) ? body.productCode : null,
      entitlementTargetSystemKey: isNonEmptyString(body.entitlementTargetSystemKey) ? body.entitlementTargetSystemKey : null,
      entitlementType: isNonEmptyString(body.entitlementType) ? body.entitlementType : null,
      rewardRuleId: isNonEmptyString(body.rewardRuleId) ? body.rewardRuleId : null,
      rewardAmountPerUnit: body.rewardAmountPerUnit ?? null,
      rewardCalculationMode: isNonEmptyString(body.rewardCalculationMode) ? body.rewardCalculationMode : null,
      revokeOnRefund: body.revokeOnRefund ?? true,
      requireCommonUserId: body.requireCommonUserId ?? false,
      requireSalesAgentId: body.requireSalesAgentId ?? false,
      requireClosingAgentId: body.requireClosingAgentId ?? false,
      requireReferralSessionKey: body.requireReferralSessionKey ?? false,
      enabled: body.enabled ?? true,
    },
  });
  res.status(201).json({ rule });
});

router.patch('/products/:productId/integration-rules/:ruleId', async (req, res) => {
  const existing = await prisma.productIntegrationRule.findUnique({ where: { id: req.params.ruleId } });
  if (!existing || existing.productId !== req.params.productId) {
    return sendError(res, 404, 'RULE_NOT_FOUND', '連携ルールが見つかりません');
  }

  const body = (req.body ?? {}) as RuleInput;
  const validationError = validateRuleInput(body);
  if (validationError) return sendError(res, 400, 'VALIDATION_ERROR', validationError);

  const rule = await prisma.productIntegrationRule.update({
    where: { id: existing.id },
    data: {
      productCode: body.productCode === undefined ? undefined : isNonEmptyString(body.productCode) ? body.productCode : null,
      entitlementTargetSystemKey:
        body.entitlementTargetSystemKey === undefined
          ? undefined
          : isNonEmptyString(body.entitlementTargetSystemKey)
            ? body.entitlementTargetSystemKey
            : null,
      entitlementType:
        body.entitlementType === undefined ? undefined : isNonEmptyString(body.entitlementType) ? body.entitlementType : null,
      rewardRuleId: body.rewardRuleId === undefined ? undefined : isNonEmptyString(body.rewardRuleId) ? body.rewardRuleId : null,
      rewardAmountPerUnit: body.rewardAmountPerUnit === undefined ? undefined : body.rewardAmountPerUnit,
      rewardCalculationMode:
        body.rewardCalculationMode === undefined
          ? undefined
          : isNonEmptyString(body.rewardCalculationMode)
            ? body.rewardCalculationMode
            : null,
      revokeOnRefund: body.revokeOnRefund,
      requireCommonUserId: body.requireCommonUserId,
      requireSalesAgentId: body.requireSalesAgentId,
      requireClosingAgentId: body.requireClosingAgentId,
      requireReferralSessionKey: body.requireReferralSessionKey,
      enabled: body.enabled,
    },
  });
  res.json({ rule });
});

export default router;
