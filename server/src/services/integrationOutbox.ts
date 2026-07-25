import crypto from 'crypto';
import type { Order, OrderItem, Prisma } from '@prisma/client';

type Tx = Prisma.TransactionClient;

// 仕様書外の拡張(千ノ国全体統合 共通実装契約 2026-07-21 6章): 決済確定・返金等のイベントを
// 下流システム(代理店システム・パスポート・ウォレット・AIアート教室)へ送信するためのOutbox。
// 決済確定と同一トランザクションでenqueueすることで、下流が停止していても決済の事実(paid)を
// 失わない。実際の送信(HMAC署名・宛先呼び出し)を行うディスパッチャは、送信先の実エンドポイント・
// 認証情報が未確定のため今回は実装しない(docs/sennokuni-integration-implementation-report.md参照)。
// enqueueした時点でOutboxにpendingとして記録されるため、宛先が確定次第、送信は安全に着手できる。

export type OutboxEventType =
  | 'order.created'
  | 'order.paid'
  | 'order.cancelled'
  | 'payment.succeeded'
  | 'payment.failed'
  | 'payment.refunded'
  | 'entitlement.granted'
  | 'entitlement.updated'
  | 'entitlement.revoked';

export interface EnqueueOutboxEventInput {
  eventType: OutboxEventType;
  destinationSystemKey: string;
  payload: Record<string, unknown>;
  correlationId?: string | null;
}

function buildEventId(): string {
  return `evt_${crypto.randomBytes(16).toString('hex')}`;
}

// 本番安定化指示書Stage7(10.1・10.2): payload更新のたびに再計算するhashをこの1箇所へ
// 集約する(integrationOutboxDispatcher.tsのdelivery_payload更新でも使う)。
export function hashOutboxPayload(payload: unknown): string {
  return crypto.createHash('sha256').update(JSON.stringify(payload)).digest('hex');
}

// 本番安定化指示書Stage7(10.2): original_payload(enqueue時点、以後不変)と
// delivery_payload(実際に送信を試みる値。ディスパッチャの再取得のたびに更新)を分離する。
// enqueue時点では両者は同じ値・同じhashで初期化する。
export async function enqueueOutboxEvent(tx: Tx, input: EnqueueOutboxEventInput): Promise<void> {
  const payloadHash = hashOutboxPayload(input.payload);
  await tx.integrationOutboxEvent.create({
    data: {
      eventId: buildEventId(),
      eventType: input.eventType,
      destinationSystemKey: input.destinationSystemKey,
      originalPayload: input.payload as Prisma.InputJsonValue,
      originalPayloadHash: payloadHash,
      deliveryPayload: input.payload as Prisma.InputJsonValue,
      deliveryPayloadHash: payloadHash,
      correlationId: input.correlationId ?? null,
    },
  });
}

function baseEventPayload(order: Order) {
  return {
    source_system_key: 'sengoku-market',
    common_user_id: order.commonUserId,
    source_user_id: order.userId,
    registration_referrer_agency_id: order.registrationReferrerAgentCode,
    assigned_agency_id: order.assignedAgentCode,
    sales_agent_id: order.salesAgentCode,
    closing_agent_id: order.closingAgentCode,
    referral_session_key: order.referralSessionKey,
    order_id: order.id,
    correlation_id: order.correlationId ?? order.id,
  };
}

// 本番安定化指示書Stage6(9.3・9.4): OVE Wallet向けのポイント計算。商品の購入数量をそのまま
// ポイント数として送らない。per_quantityのみ数量に比例させ、それ以外(fixed_per_order・
// fixed_total・未設定)はrewardAmountPerUnitをそのまま固定額として使う。
function computeOveRewardAmount(rule: { rewardAmountPerUnit: number | null; rewardCalculationMode: string | null }, quantity: number): number {
  const perUnit = rule.rewardAmountPerUnit ?? 0;
  if (rule.rewardCalculationMode === 'per_quantity') return perUnit * quantity;
  return perUnit;
}

// 商品ごとの権利付与ルーティング設定(product_integration_rules)を参照し、entitlement.granted/
// entitlement.revokedをenqueueする。ルール未設定の商品(現状すべて)は対象外のためno-opになる
// (評議員NFTはこのシステム単独で完結する方針のため、意図的に未設定のままにしている)。
// 本番安定化指示書Stage6(9.1・9.2): 1商品から複数のルール(送信先ごとに1行)を持てるため、
// 1商品につき1件だけ送るのではなく、対象商品の有効なルールすべてについてイベントをenqueueする
// (例: AIアート教室の権利付与とOVEポイント付与を同一商品・同一注文明細から同時に行える)。
export async function enqueueEntitlementEvents(
  tx: Tx,
  order: Order,
  orderItems: OrderItem[],
  eventType: 'entitlement.granted' | 'entitlement.revoked',
): Promise<void> {
  for (const item of orderItems) {
    const rules = await tx.productIntegrationRule.findMany({ where: { productId: item.productId } });
    for (const rule of rules) {
      if (!rule.enabled) continue;
      if (!rule.entitlementTargetSystemKey) continue;
      if (eventType === 'entitlement.revoked' && !rule.revokeOnRefund) continue;

      await enqueueOutboxEvent(tx, {
        eventType,
        destinationSystemKey: rule.entitlementTargetSystemKey,
        correlationId: order.correlationId ?? order.id,
        payload: {
          ...baseEventPayload(order),
          order_item_id: item.id,
          // 仕様書外の拡張(残課題指示書Stage6): Dispatcherが送信直前に最新の
          // product_integration_rule(必須ID設定)を再取得できるよう、product_idをpayloadへ含める。
          product_id: item.productId,
          // 本番安定化指示書Stage6(9.2): 1商品に複数ルールがありうるため、product_idだけでは
          // どのルールに基づくイベントか一意に特定できない。再取得はルールid基準で行う。
          product_integration_rule_id: rule.id,
          product_code: rule.productCode,
          entitlement_type: rule.entitlementType,
          quantity: item.quantity,
          // 本番安定化指示書Stage6(9.4): OVE Wallet向けの送信時に使う値をenqueue時点で
          // スナップショットする(注文に関わる率・額は注文時点の値を保存する原則)。
          reward_rule_id: rule.rewardRuleId,
          reward_amount: computeOveRewardAmount(rule, item.quantity),
        },
      });
    }
  }
}
