import crypto from 'crypto';
import type { IntegrationOutboxEvent, Prisma } from '@prisma/client';
import { prisma } from '../lib/prisma';
import {
  isSennokuniIntegrationEnabled,
  getSennokuniHubCredentials,
  getIntegrationEndpointBaseUrl,
  getIntegrationEndpointPath,
  getSennokuniIntegrationStage,
  type SennokuniIntegrationStage,
} from './sennokuniIntegrationConfig';
import { buildSennokuniHeaders } from '../lib/sennokuniHmac';
import { grantReward, reverseReward } from './oveWalletRewardClient';
import { hashOutboxPayload } from './integrationOutbox';

// 仕様書外の拡張(千ノ国全体連携 共通インターフェース契約v1.1 DRAFT 9章・2026-07-22指示書対応):
// integration_outbox_eventsの実送信ディスパッチャ。NFT自動発行の既存cron(nftMintProcessing.ts)と
// 同じ「条件付きUPDATEによるアトミックなclaim + 指数バックオフ + 最大試行超過でdead」設計を踏襲する。
// SENNOKUNI_INTEGRATION_ENABLED(既定OFF)が有効化されるまで、呼び出してもpending件数を数えるだけで
// 実送信は一切発生しない("Feature Flagでdormantなコード"という方針)。
//
// 残課題指示書Stage7: 1バッチあたりの件数・送信先ごとの上限・claim所有権(processing_token)・
// Function実行時間の監視・試行履歴の記録を強化した。

const BATCH_LIMIT = 10;
// 外部APIごとの同時実行上限(1回のdispatch呼び出しで同一destination_system_keyから
// claimする最大件数)。Dispatcher自体は逐次処理だが、cronと即時実行が重なった場合でも
// 1つの送信先へ集中しすぎないようにする。
const PER_DESTINATION_BATCH_LIMIT = 5;
const MAX_ATTEMPTS = 5;
// 5→10→20→40→60分(以降は60分キャップ)。NFT自動発行(nftMintProcessing.ts)と同じ指数バックオフ。
const BACKOFF_MINUTES = [5, 10, 20, 40, 60];
const STALE_PROCESSING_MS = 10 * 60 * 1000;
const FETCH_TIMEOUT_MS = 8000;

// Functionの残り時間に余裕がない場合は新規claimを打ち切る(9.2「実行時間」)。Vercelのプラン
// (Function timeout)によって安全な値が変わるため環境変数で調整可能にし、既定値は保守的に
// 短め(Hobbyプランの制限時間を意識した値)にしておく。呼び出しごとに読み直すことで、
// デプロイし直さずに調整できるようにする(isSennokuniIntegrationEnabledと同じ方針)。
function getTimeBudgetMs(): number {
  const raw = process.env.INTEGRATION_OUTBOX_TIME_BUDGET_MS;
  if (raw === undefined) return 8000;
  const parsed = Number(raw);
  // "0"(即座に打ち切り、テスト用途)も有効な設定値として扱うため、`||`ではなくisFiniteで判定する。
  return Number.isFinite(parsed) ? parsed : 8000;
}

export interface DispatchOutboxResult {
  claimed: number;
  succeeded: number;
  retrying: number;
  dead: number;
  skipped: number;
  blocked: number;
}

function generateProcessingToken(): string {
  return crypto.randomBytes(16).toString('hex');
}

export async function dispatchPendingOutboxEvents(): Promise<DispatchOutboxResult> {
  const result: DispatchOutboxResult = { claimed: 0, succeeded: 0, retrying: 0, dead: 0, skipped: 0, blocked: 0 };

  if (!isSennokuniIntegrationEnabled()) return result;

  // 本番安定化指示書Stage8(11.4「段階化」): dry_runでは実送信を一切行わず、署名・payload・
  // URLの生成とvalidationのみ行う(sendOutboxEvent内で分岐する)。
  const stage = await getSennokuniIntegrationStage();

  const dispatchStartedAt = Date.now();

  // 1) staleなprocessing行(クラッシュ等で放置)を先にpending・token解除の状態へ戻す。
  // processing_started_atを基準にすることで、Stage3/4/notification_outbox_events・
  // order_linking_jobsと同じ検知方法に揃える。
  await prisma.integrationOutboxEvent.updateMany({
    where: { status: 'processing', processingStartedAt: { lt: new Date(Date.now() - STALE_PROCESSING_MS) } },
    data: { status: 'pending', processingToken: null, processingStartedAt: null },
  });

  // 2) 送信対象をclaimして送信する。残課題指示書Stage6: blocked行も毎回再評価対象に含めることで、
  // 必須ID解決後に自動的に送信を再開できるようにする(8.4「ID解決後に自動再開」)。
  const candidates = await prisma.integrationOutboxEvent.findMany({
    where: { status: { in: ['pending', 'blocked'] }, OR: [{ nextAttemptAt: null }, { nextAttemptAt: { lte: new Date() } }] },
    orderBy: { createdAt: 'asc' },
    take: BATCH_LIMIT * 10, // 送信先ごとの上限を後段でJS側から適用するため、やや広めに候補を取得する。
  });

  const perDestinationCount = new Map<string, number>();
  const rowsToProcess: IntegrationOutboxEvent[] = [];
  for (const row of candidates) {
    if (rowsToProcess.length >= BATCH_LIMIT) break;
    const count = perDestinationCount.get(row.destinationSystemKey) ?? 0;
    if (count >= PER_DESTINATION_BATCH_LIMIT) continue;
    perDestinationCount.set(row.destinationSystemKey, count + 1);
    rowsToProcess.push(row);
  }

  for (const row of rowsToProcess) {
    if (Date.now() - dispatchStartedAt >= getTimeBudgetMs()) {
      // 9.2「実行時間」: Functionの残り時間に余裕がないため、これ以上は新規claimしない
      // (claim済みでない行はpending/blockedのまま残り、次回のdispatchで再評価される)。
      break;
    }

    const processingToken = generateProcessingToken();
    const claim = await prisma.integrationOutboxEvent.updateMany({
      where: { id: row.id, status: row.status },
      data: { status: 'processing', processingToken, processingStartedAt: new Date() },
    });
    if (claim.count === 0) {
      result.skipped++;
      continue;
    }
    result.claimed++;
    await sendAndRecordResult({ ...row, status: 'processing', processingToken }, result, stage);
  }

  return result;
}

// 仕様書外の拡張(残課題指示書Stage7・9.2「再試行」): cronは日次実行のため、backoffの初期値
// (5分)との乖離が大きい。決済確定・返金等でentitlement Outboxへenqueueした直後にも
// ベストエフォートで即時ディスパッチを試みることで、多くの送信はcronを待たずに完了させ、
// cronは主に「取りこぼし・失敗時の再試行」のセーフティネットとして機能させる
// (NFT自動発行のtriggerImmediateNftMintProcessingと同じ考え方)。
export async function triggerImmediateOutboxDispatch(): Promise<void> {
  try {
    await dispatchPendingOutboxEvents();
  } catch (e) {
    console.error('immediate integration outbox dispatch failed', { error: e });
  }
}

// 仕様書外の拡張(残課題指示書Stage6・8.2推奨順位1〜3): 送信直前に注文の最新状態を再取得し、
// enqueue時点でスナップショットしたcommon_user_id等が古いままpayloadに焼き付いていないか
// 補正する。product_integration_rulesの必須ID設定(8.3)のうち未解決のものがあれば、送信せず
// blocked(理由付き)として返す。order_idを持たない(=entitlement系ではない)イベントは対象外。
async function reconcileEntitlementFields(
  event: IntegrationOutboxEvent,
): Promise<{ blockedReason: string | null; effectivePayload: Record<string, unknown> }> {
  // 本番安定化指示書Stage7(10.2): 再取得のたびにoriginal_payload(enqueue時点、以後不変)を
  // 基準にする。delivery_payloadを基準にすると、以前の再取得結果(古いcommon_user_id等)が
  // 積み重なって残ってしまう可能性があるため。
  const payload = event.originalPayload as Record<string, unknown>;
  const orderId = typeof payload.order_id === 'string' ? payload.order_id : null;
  if (!orderId) return { blockedReason: null, effectivePayload: payload };

  const order = await prisma.order.findUnique({ where: { id: orderId } });
  if (!order) return { blockedReason: null, effectivePayload: payload };

  const effectivePayload: Record<string, unknown> = {
    ...payload,
    common_user_id: order.commonUserId,
    sales_agent_id: order.salesAgentCode,
    closing_agent_id: order.closingAgentCode,
    referral_session_key: order.referralSessionKey,
    registration_referrer_agency_id: order.registrationReferrerAgentCode,
    assigned_agency_id: order.assignedAgentCode,
  };

  // 本番安定化指示書Stage6(9.2): 1商品に複数ルールを持てるようになったため、product_idではなく
  // enqueue時点でスナップショットしたルールidで再取得する(product_idだけではどのルールに
  // 基づくイベントか一意に特定できない)。
  const ruleId = typeof payload.product_integration_rule_id === 'string' ? payload.product_integration_rule_id : null;
  const rule = ruleId ? await prisma.productIntegrationRule.findUnique({ where: { id: ruleId } }) : null;
  if (!rule) return { blockedReason: null, effectivePayload };
  if (!rule.enabled) return { blockedReason: 'integration_rule_disabled', effectivePayload };

  if (rule.requireCommonUserId && !order.commonUserId) return { blockedReason: 'common_user_unresolved', effectivePayload };
  if (rule.requireSalesAgentId && !order.salesAgentCode) return { blockedReason: 'sales_agent_unresolved', effectivePayload };
  if (rule.requireClosingAgentId && !order.closingAgentCode) return { blockedReason: 'closing_agent_unresolved', effectivePayload };
  if (rule.requireReferralSessionKey && !order.referralSessionKey) {
    return { blockedReason: 'referral_session_unresolved', effectivePayload };
  }

  return { blockedReason: null, effectivePayload };
}

// 仕様書外の拡張(残課題指示書Stage7): 送信先からの非2xx応答等、HTTPステータスを持つ失敗を
// 試行履歴(integration_event_attempts.http_status)へ記録できるようにする。
// 本番安定化指示書Stage7(10.3): 送信先URL・応答本文の抜粋(秘密情報は含めない)も持たせる。
class OutboxSendError extends Error {
  httpStatus?: number;
  destinationUrl?: string | null;
  responseBodyExcerpt?: string | null;
  constructor(message: string, opts?: { httpStatus?: number; destinationUrl?: string | null; responseBodyExcerpt?: string | null }) {
    super(message);
    this.name = 'OutboxSendError';
    this.httpStatus = opts?.httpStatus;
    this.destinationUrl = opts?.destinationUrl ?? null;
    this.responseBodyExcerpt = opts?.responseBodyExcerpt ?? null;
  }
}

interface SendOutcome {
  destinationUrl: string | null;
  responseBodyExcerpt: string | null;
}

async function sendAndRecordResult(
  event: IntegrationOutboxEvent,
  result: DispatchOutboxResult,
  stage: SennokuniIntegrationStage,
): Promise<void> {
  const processingToken = event.processingToken!;
  const { blockedReason, effectivePayload } = await reconcileEntitlementFields(event);
  // 本番安定化指示書Stage7(10.1・10.2): delivery_payloadを更新する際は必ずhashも
  // 再計算する(保存payloadとhashが一致しない不整合を防ぐ)。
  const deliveryPayloadHash = hashOutboxPayload(effectivePayload);

  if (blockedReason) {
    // blockedは「送信を試みていない」状態のため、試行履歴(integration_event_attempts)には残さない。
    await prisma.integrationOutboxEvent.updateMany({
      where: { id: event.id, status: 'processing', processingToken },
      data: { status: 'blocked', blockedReason, deliveryPayload: effectivePayload as Prisma.InputJsonValue, deliveryPayloadHash },
    });
    result.blocked++;
    return;
  }

  const effectiveEvent: IntegrationOutboxEvent = { ...event, deliveryPayload: effectivePayload as Prisma.JsonValue };
  const attemptNumber = event.attemptCount + 1;
  const startedAt = new Date();

  try {
    const outcome = await sendOutboxEvent(effectiveEvent, stage);
    await recordAttempt({
      event,
      attemptNumber,
      startedAt,
      processingToken,
      result: 'succeeded',
      httpStatus: null,
      error: null,
      requestPayloadHash: deliveryPayloadHash,
      destinationUrl: outcome.destinationUrl,
      responseBodyExcerpt: outcome.responseBodyExcerpt,
    });
    // 古いclaim(stale再クレーム後に別プロセスが先に処理した等)が、後から届いた新しい結果を
    // 上書きしないよう、processing・同一tokenであることを条件にする(9.3「古い処理が新しい
    // 結果を上書きしない」)。effectiveEvent.deliveryPayload(sendOutboxEvent内でove_transaction_id
    // 等が追記されている可能性がある)を保存し、hashも合わせて再計算する。
    const finalPayload = effectiveEvent.deliveryPayload as Record<string, unknown>;
    await prisma.integrationOutboxEvent.updateMany({
      where: { id: event.id, status: 'processing', processingToken },
      data: {
        status: 'succeeded',
        processedAt: new Date(),
        lastError: null,
        blockedReason: null,
        deliveryPayload: finalPayload as Prisma.InputJsonValue,
        deliveryPayloadHash: hashOutboxPayload(finalPayload),
        processingToken: null,
        processingStartedAt: null,
      },
    });
    result.succeeded++;
  } catch (e) {
    const httpStatus = e instanceof OutboxSendError ? (e.httpStatus ?? null) : null;
    const destinationUrl = e instanceof OutboxSendError ? (e.destinationUrl ?? null) : null;
    const responseBodyExcerpt = e instanceof OutboxSendError ? (e.responseBodyExcerpt ?? null) : null;
    const message = (e instanceof Error ? e.message : String(e)).slice(0, 2000);
    await recordAttempt({
      event,
      attemptNumber,
      startedAt,
      processingToken,
      result: 'failed',
      httpStatus,
      error: message,
      requestPayloadHash: deliveryPayloadHash,
      destinationUrl,
      responseBodyExcerpt,
    });

    if (attemptNumber >= MAX_ATTEMPTS) {
      await prisma.integrationOutboxEvent.updateMany({
        where: { id: event.id, status: 'processing', processingToken },
        data: {
          status: 'dead',
          attemptCount: attemptNumber,
          lastError: message,
          blockedReason: null,
          deliveryPayload: effectivePayload as Prisma.InputJsonValue,
          deliveryPayloadHash,
          processingToken: null,
          processingStartedAt: null,
        },
      });
      result.dead++;
    } else {
      const backoffMinutes = BACKOFF_MINUTES[Math.min(attemptNumber - 1, BACKOFF_MINUTES.length - 1)];
      await prisma.integrationOutboxEvent.updateMany({
        where: { id: event.id, status: 'processing', processingToken },
        data: {
          status: 'pending',
          attemptCount: attemptNumber,
          lastError: message,
          blockedReason: null,
          deliveryPayload: effectivePayload as Prisma.InputJsonValue,
          deliveryPayloadHash,
          processingToken: null,
          processingStartedAt: null,
          nextAttemptAt: new Date(Date.now() + backoffMinutes * 60 * 1000),
        },
      });
      result.retrying++;
    }
  }
}

// 仕様書外の拡張(残課題指示書Stage7・9.2「試行履歴」): 実際に送信を試みた回(成功・失敗いずれも)
// を1行記録する。管理画面での障害調査・監査用。
async function recordAttempt(input: {
  event: IntegrationOutboxEvent;
  attemptNumber: number;
  startedAt: Date;
  processingToken: string;
  result: 'succeeded' | 'failed';
  httpStatus: number | null;
  error: string | null;
  // 本番安定化指示書Stage7(10.3): この試行で実際に送信を試みたdelivery_payloadのhash・
  // 送信先URL・応答本文の抜粋(取得できない経路ではnull)。
  requestPayloadHash: string;
  destinationUrl: string | null;
  responseBodyExcerpt: string | null;
}): Promise<void> {
  await prisma.integrationEventAttempt.create({
    data: {
      outboxEventId: input.event.id,
      attemptNumber: input.attemptNumber,
      startedAt: input.startedAt,
      finishedAt: new Date(),
      httpStatus: input.httpStatus,
      result: input.result,
      error: input.error,
      processingToken: input.processingToken,
      requestPayloadHash: input.requestPayloadHash,
      destinationUrl: input.destinationUrl,
      responseBodyExcerpt: input.responseBodyExcerpt,
    },
  });
}

async function sendOutboxEvent(event: IntegrationOutboxEvent, stage: SennokuniIntegrationStage): Promise<SendOutcome> {
  if (event.destinationSystemKey === 'ove-wallet') {
    return sendToOveWallet(event, stage);
  }
  return sendViaCommonContract(event, stage);
}

// 仕様書外の拡張: OVE Walletはentitlement.granted/revokedという概念を持たず、reward付与・取消
// (grant/REVERSAL)というAPIを持つため、Outbox上のイベント種別をウォレットAPI呼び出しへ変換する。
// 本番安定化指示書Stage7(10.3): oveWalletRewardClient.tsは送信先URL・生の応答本文を返さない
// 抽象化されたクライアントのため、この経路ではdestinationUrl/responseBodyExcerptは取得できず
// 常にnullとなる(既知の制約。変更する場合はoveWalletRewardClient.tsのインターフェース自体の
// 見直しが必要なため、今回は対象外とする)。
async function sendToOveWallet(event: IntegrationOutboxEvent, stage: SennokuniIntegrationStage): Promise<SendOutcome> {
  const payload = event.deliveryPayload as {
    common_user_id?: string | null;
    source_user_id?: string | null;
    order_item_id?: string;
    quantity?: number;
    reward_amount?: number;
    reward_rule_id?: string | null;
    correlation_id?: string;
  };

  if (event.eventType === 'entitlement.granted') {
    // 本番安定化指示書Stage6(9.4): 商品数量をそのままポイント数にしない。enqueue時点で
    // product_integration_rulesの設定(reward_calculation_mode等)に基づき計算済みの
    // reward_amountを使う(enqueueEntitlementEvents参照)。
    if (typeof payload.reward_amount !== 'number') {
      throw new Error('reward_amount is missing on entitlement.granted payload for ove-wallet');
    }

    // 本番安定化指示書Stage8(11.4「dry_run」): 実際にはgrantReward(実送信・実際にポイントが
    // 付与される)を呼ばず、必須項目のvalidationのみ行う。ove_transaction_idは記録しない
    // (dry_runでは実際の付与が起きていないため、後続のentitlement.revokedが誤って
    // 「取消対象が見つかった」と誤認しないようにするため)。
    if (stage === 'dry_run') {
      if (!payload.source_user_id) throw new Error('source_user_id is missing on entitlement.granted payload for ove-wallet');
      return { destinationUrl: null, responseBodyExcerpt: '[DRY_RUN] validated only, not sent (ove-wallet grant)' };
    }

    const grantResult = await grantReward({
      externalUserId: payload.source_user_id ?? '',
      commonUserId: payload.common_user_id ?? null,
      amount: payload.reward_amount,
      rewardRuleId: payload.reward_rule_id ?? null,
      idempotencyKey: event.eventId,
      correlationId: payload.correlation_id ?? event.correlationId ?? event.eventId,
    });
    if (!grantResult) throw new Error('OVE wallet reward grant failed or not configured');

    // 返金時のREVERSAL対象を追跡できるよう、成功した付与のtransaction_idをpayloadへ記録する。
    // 仕様書外の拡張として簡易に実装しているが、本来は専用のorder_wallet_transactionsテーブルで
    // 管理すべき情報であり(実装報告書の既知の未対応事項)、現時点での暫定対応にとどまる。
    // DBへは直接書かず、呼び出し元(sendAndRecordResult)が送信成功時にまとめて1回で永続化する
    // (残課題指示書Stage6でDispatcherがpayloadを再構築するようになったため、途中で個別に書き込むと
    // 後続の永続化で上書き・消失してしまうのを避けるため、メモリ上のオブジェクトを直接更新する)。
    (event.deliveryPayload as Record<string, unknown>).ove_transaction_id = grantResult.transactionId;
    return { destinationUrl: null, responseBodyExcerpt: null };
  }

  if (event.eventType === 'entitlement.revoked') {
    const priorGrant = await prisma.integrationOutboxEvent.findFirst({
      where: {
        destinationSystemKey: 'ove-wallet',
        eventType: 'entitlement.granted',
        status: 'succeeded',
        deliveryPayload: { path: ['order_item_id'], equals: payload.order_item_id },
      },
    });
    const priorPayload = priorGrant?.deliveryPayload as { ove_transaction_id?: string } | undefined;
    if (!priorPayload?.ove_transaction_id) {
      throw new Error('cannot reverse OVE wallet reward: no matching prior grant transaction found');
    }

    if (stage === 'dry_run') {
      return { destinationUrl: null, responseBodyExcerpt: '[DRY_RUN] validated only, not sent (ove-wallet reversal)' };
    }

    const reversed = await reverseReward(priorPayload.ove_transaction_id, 'entitlement revoked (refund)');
    if (!reversed) throw new Error('OVE wallet reward reversal failed');
    return { destinationUrl: null, responseBodyExcerpt: null };
  }

  throw new Error(`unsupported event type for ove-wallet: ${event.eventType}`);
}

// 仕様書外の拡張(残課題指示書Stage7・9.2「正式URL」): パスポート・AIアート教室向けは共通契約
// (X-SenNoKuni-*)のイベントEnvelopeで送信する。受信pathは送信先ごとの設定値
// (getIntegrationEndpointPath)から取得し、コード固定しない。
// 本番安定化指示書Stage8(11.1・11.5): 未設定時の暫定path('/shopping/webhook')への
// 自動フォールバックは廃止した。未設定はfail-close(送信せず失敗させる)。
async function sendViaCommonContract(event: IntegrationOutboxEvent, stage: SennokuniIntegrationStage): Promise<SendOutcome> {
  const baseUrl = await getIntegrationEndpointBaseUrl(event.destinationSystemKey);
  if (!baseUrl) throw new Error(`no endpoint configured for destination: ${event.destinationSystemKey}`);

  const credentials = await getSennokuniHubCredentials();
  if (!credentials) throw new Error('sennokuni HMAC credentials are not configured');

  const path = await getIntegrationEndpointPath(event.destinationSystemKey);
  if (!path) throw new Error(`no endpoint path configured for destination: ${event.destinationSystemKey}`);
  const method = 'POST';
  const payload = event.deliveryPayload as { common_user_id?: string | null };
  const envelope = {
    event_id: event.eventId,
    event_type: event.eventType,
    event_version: event.eventVersion,
    occurred_at: event.createdAt.toISOString(),
    source_system_key: 'sengoku-market',
    common_user_id: payload.common_user_id ?? null,
    correlation_id: event.correlationId,
    data: event.deliveryPayload,
  };
  const rawBody = JSON.stringify(envelope);
  const timestamp = String(Math.floor(Date.now() / 1000));
  const nonce = crypto.randomBytes(16).toString('hex');
  // HMAC署名対象pathと実送信pathが必ず一致するよう、同じ`path`変数を両方に使う(9.3受入条件)。
  const headers = buildSennokuniHeaders({
    keyId: credentials.keyId,
    secret: credentials.secret,
    timestamp,
    nonce,
    method,
    path,
    rawBody,
    eventVersion: event.eventVersion,
    idempotencyKey: event.eventId,
    correlationId: event.correlationId ?? undefined,
  });

  const destinationUrl = `${baseUrl}${path}`;

  // 本番安定化指示書Stage8(11.4「dry_run」): ここまででURL・HMAC署名・payloadは実際に
  // 生成済み(validationも通過している)。実際のfetch()は行わず、検証のみで完了とする。
  if (stage === 'dry_run') {
    return { destinationUrl, responseBodyExcerpt: '[DRY_RUN] validated only, not sent' };
  }

  let res: Response;
  try {
    res = await fetch(destinationUrl, {
      method,
      headers,
      body: rawBody,
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });
  } catch (e) {
    throw new OutboxSendError(e instanceof Error ? e.message : String(e), { destinationUrl });
  }

  // 本番安定化指示書Stage7(10.3): 応答本文の抜粋を試行履歴へ残す(秘密情報が含まれないよう
  // 短く切り詰める。送信先が秘密情報を返すことは想定していないが、念のため長さを制限する)。
  const responseBodyExcerpt =
    typeof res.text === 'function'
      ? await res
          .text()
          .then((t) => t.slice(0, 500))
          .catch(() => null)
      : null;

  if (!res.ok) {
    throw new OutboxSendError(`destination returned non-2xx: ${res.status}`, { httpStatus: res.status, destinationUrl, responseBodyExcerpt });
  }

  return { destinationUrl, responseBodyExcerpt };
}

// 仕様書外の拡張(残課題指示書Stage7・9.2「手動再送」): 管理画面からのdead/failed/blocked/pending
// イベントの手動再送。既存の状態から条件付きUPDATEでprocessingへclaimし、通常のdispatchと同じ
// 経路(reconcile→blocked判定→送信→試行履歴記録)で1件だけ処理する。
export async function retryOutboxEvent(id: string): Promise<{ ok: boolean; status?: string }> {
  // Feature Flag無効時は手動再送であっても実送信を行わない(dispatchPendingOutboxEventsと
  // 同じ「Flag無効=常にdormant」という原則を管理操作にも一貫させる)。
  if (!isSennokuniIntegrationEnabled()) return { ok: false };

  const existing = await prisma.integrationOutboxEvent.findUnique({ where: { id } });
  if (!existing || existing.status === 'processing' || existing.status === 'succeeded') {
    return { ok: false };
  }

  const processingToken = generateProcessingToken();
  const claim = await prisma.integrationOutboxEvent.updateMany({
    where: { id, status: existing.status },
    data: { status: 'processing', processingToken, processingStartedAt: new Date() },
  });
  if (claim.count === 0) return { ok: false };

  const result: DispatchOutboxResult = { claimed: 1, succeeded: 0, retrying: 0, dead: 0, skipped: 0, blocked: 0 };
  const stage = await getSennokuniIntegrationStage();
  await sendAndRecordResult({ ...existing, status: 'processing', processingToken }, result, stage);

  const refreshed = await prisma.integrationOutboxEvent.findUnique({ where: { id } });
  return { ok: true, status: refreshed?.status };
}
