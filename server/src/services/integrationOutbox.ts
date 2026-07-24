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

export async function enqueueOutboxEvent(tx: Tx, input: EnqueueOutboxEventInput): Promise<void> {
  const payloadJson = JSON.stringify(input.payload);
  await tx.integrationOutboxEvent.create({
    data: {
      eventId: buildEventId(),
      eventType: input.eventType,
      destinationSystemKey: input.destinationSystemKey,
      payload: input.payload as Prisma.InputJsonValue,
      payloadHash: crypto.createHash('sha256').update(payloadJson).digest('hex'),
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

// 商品ごとの権利付与ルーティング設定(product_integration_rules)を参照し、entitlement.granted/
// entitlement.revokedをenqueueする。ルール未設定の商品(現状すべて)は対象外のためno-opになる
// (評議員NFTはこのシステム単独で完結する方針のため、意図的に未設定のままにしている)。
export async function enqueueEntitlementEvents(
  tx: Tx,
  order: Order,
  orderItems: OrderItem[],
  eventType: 'entitlement.granted' | 'entitlement.revoked',
): Promise<void> {
  for (const item of orderItems) {
    const rule = await tx.productIntegrationRule.findUnique({ where: { productId: item.productId } });
    if (!rule?.entitlementTargetSystemKey) continue;
    if (eventType === 'entitlement.revoked' && !rule.revokeOnRefund) continue;

    await enqueueOutboxEvent(tx, {
      eventType,
      destinationSystemKey: rule.entitlementTargetSystemKey,
      correlationId: order.correlationId ?? order.id,
      payload: {
        ...baseEventPayload(order),
        order_item_id: item.id,
        // 仕様書外の拡張(残課題指示書Stage6): Dispatcherが送信直前に最新のproduct_integration_rule
        // (必須ID設定)を再取得できるよう、product_idをpayloadへ含める。
        product_id: item.productId,
        product_code: rule.productCode,
        entitlement_type: rule.entitlementType,
        quantity: item.quantity,
      },
    });
  }
}
