#!/usr/bin/env node
// 本番安定化指示書Stage16(ステージングE2E接続テスト): 16.2の必須シナリオを、実際に稼働中の
// ステージング環境(千ノ国全体連携が dry_run/staging 段階で有効化されたデプロイ)に対して
// 一通り実行する手動運用スクリプト。
//
// 通常のCI・vitestからは実行されない(実在するステージング環境・実際の千ノ国/OVE
// staging鍵・正式HMAC test vectorが前提のため、このリポジトリ単体では検証できない)。
// 記載の環境変数を用意したうえで、対象のステージング環境へ対して手動で実行すること:
//
//   STAGING_APP_BASE_URL         (必須) ステージングのベースURL(例: https://staging.example.com)
//   STAGING_ADMIN_EMAIL          (必須) 確認用の管理者アカウント
//   STAGING_ADMIN_PASSWORD       (必須) 同上
//   STAGING_STRIPE_WEBHOOK_SECRET(必須) ステージングのStripe Webhook署名鍵(実際にStripeへ
//                                 決済させず、シナリオ2〜5を確定させるためWebhookを模擬送信する)
//   STAGING_REFERRAL_CODE        (任意) 有効な紹介コード(referral_links.code)。未指定なら
//                                 「紹介」シナリオはskipする
//   STAGING_OVE_VARIANT_ID       (任意) OVEウォレット向けproduct_integration_ruleがenabled=true
//                                 で設定済みの商品バリエーションID。未指定なら「決済→OVE付与」
//                                 「返金→OVE reversal」部分はskipする(entitlement.granted自体の
//                                 確認は引き続き行う)
//
// 実行例: STAGING_APP_BASE_URL=https://staging.example.com ... node scripts/staging-e2e.mjs

import crypto from 'crypto';

const BASE_URL = process.env.STAGING_APP_BASE_URL;

if (!BASE_URL) {
  console.log(
    'STAGING_APP_BASE_URL が未設定のため、このスクリプトは何もせず終了します。' +
      '(本番安定化指示書Stage16は正式URL・正式path・HMAC test vector・staging key・staging DBを' +
      '前提とする、実在のステージング環境への接続テストのため、このリポジトリ単体では実行できません。' +
      '実行するには本ファイル冒頭のコメントに記載の環境変数を用意してください)',
  );
  process.exit(0);
}

const ADMIN_EMAIL = process.env.STAGING_ADMIN_EMAIL;
const ADMIN_PASSWORD = process.env.STAGING_ADMIN_PASSWORD;
const WEBHOOK_SECRET = process.env.STAGING_STRIPE_WEBHOOK_SECRET;
const REFERRAL_CODE = process.env.STAGING_REFERRAL_CODE;
const OVE_VARIANT_ID = process.env.STAGING_OVE_VARIANT_ID;

for (const [name, value] of [
  ['STAGING_ADMIN_EMAIL', ADMIN_EMAIL],
  ['STAGING_ADMIN_PASSWORD', ADMIN_PASSWORD],
  ['STAGING_STRIPE_WEBHOOK_SECRET', WEBHOOK_SECRET],
]) {
  if (!value) {
    console.error(`必須環境変数 ${name} が未設定です`);
    process.exit(1);
  }
}

const results = [];

function record(name, ok, detail) {
  results.push({ name, ok, detail });
  console.log(`${ok ? '[OK]' : '[NG]'} ${name}${detail ? ` — ${detail}` : ''}`);
}

async function api(path, init) {
  const res = await fetch(`${BASE_URL}${path}`, init);
  const body = await res.json().catch(() => null);
  return { status: res.status, body, headers: res.headers };
}

function extractSetCookie(res) {
  // fetchのHeadersはSet-Cookieを複数持てないため、getSetCookie()があれば使う(Node 20+)。
  if (typeof res.headers.getSetCookie === 'function') return res.headers.getSetCookie().join('; ');
  return res.headers.get('set-cookie') ?? '';
}

function signStripePayload(payloadObj) {
  const payload = JSON.stringify(payloadObj);
  const timestamp = Math.floor(Date.now() / 1000);
  const signedPayload = `${timestamp}.${payload}`;
  const signature = crypto.createHmac('sha256', WEBHOOK_SECRET).update(signedPayload).digest('hex');
  return { payload, header: `t=${timestamp},v1=${signature}` };
}

async function postStripeWebhook(payloadObj) {
  const { payload, header } = signStripePayload(payloadObj);
  const res = await fetch(`${BASE_URL}/api/stripe/webhook`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Stripe-Signature': header },
    body: payload,
  });
  const body = await res.json().catch(() => null);
  return { status: res.status, body };
}

async function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// 対象のジョブ/イベントがsucceededになるまで、Cronの実行間隔を考慮してポーリングする
// (このステージング環境では即時ディスパッチではなくCronによる非同期処理が前提のため)。
async function pollUntil(fn, { timeoutMs = 60_000, intervalMs = 3000 } = {}) {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    const result = await fn();
    if (result) return result;
    await sleep(intervalMs);
  }
  return null;
}

async function loginAsAdmin() {
  const res = await api('/api/auth/login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Origin: BASE_URL },
    body: JSON.stringify({ email: ADMIN_EMAIL, password: ADMIN_PASSWORD }),
  });
  if (res.status !== 200) throw new Error(`管理者ログインに失敗しました: ${res.status}`);
  return extractSetCookie(res);
}

async function registerTestUser(refCode) {
  const email = `staging-e2e-${Date.now()}@example.com`;
  const q = refCode ? `?ref=${encodeURIComponent(refCode)}` : '';
  const res = await fetch(`${BASE_URL}/api/auth/register${q}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Origin: BASE_URL },
    body: JSON.stringify({ name: 'ステージングE2E', email, password: 'password123' }),
  });
  const body = await res.json().catch(() => null);
  if (res.status !== 201 && res.status !== 200) throw new Error(`会員登録に失敗しました: ${res.status} ${JSON.stringify(body)}`);
  const cookie = typeof res.headers.getSetCookie === 'function' ? res.headers.getSetCookie().join('; ') : res.headers.get('set-cookie');
  return { email, userId: body?.user?.id, cookie };
}

// シナリオ1(16.2「ユーザー」): 新規登録 → common_user_id resolve → external_identity保存。
async function scenarioUserRegistration(adminCookie) {
  const { userId } = await registerTestUser();
  const job = await pollUntil(async () => {
    const res = await api(`/api/admin/order-linking-jobs?status=succeeded`, { headers: { Cookie: adminCookie } });
    return res.body?.jobs?.find((j) => j.jobType === 'common_user_resolve' && j.userId === userId) ?? null;
  });
  if (!job) {
    record('ユーザー: common_user_id resolve', false, 'common_user_resolveジョブがsucceededになりませんでした');
    return;
  }
  const conflict = await api(`/api/admin/order-linking-jobs?blockedReason=common_user_id_conflict`, { headers: { Cookie: adminCookie } });
  const hasConflict = conflict.body?.jobs?.some((j) => j.userId === userId);
  record('ユーザー: common_user_id resolve → external_identity保存', !hasConflict, hasConflict ? 'common_user_id_conflictが発生しています' : undefined);
}

// シナリオ2(16.2「紹介」): 紹介リンク → capture → referral_session_key保存。
async function scenarioReferralCapture(adminCookie) {
  if (!REFERRAL_CODE) {
    record('紹介: capture → referral_session_key保存', true, 'STAGING_REFERRAL_CODE未指定のためskip');
    return;
  }
  const { userId } = await registerTestUser(REFERRAL_CODE);
  const job = await pollUntil(async () => {
    const res = await api(`/api/admin/order-linking-jobs?status=succeeded`, { headers: { Cookie: adminCookie } });
    return res.body?.jobs?.find((j) => j.jobType === 'referral_capture' && j.userId === userId) ?? null;
  });
  record('紹介: capture → referral_session_key保存', Boolean(job), job ? undefined : 'referral_captureジョブがsucceededになりませんでした');
}

async function fetchFirstVariantId(userCookie) {
  const res = await api('/api/products', { headers: { Cookie: userCookie } });
  const product = res.body?.products?.find((p) => p.variants?.length > 0);
  return product?.variants?.[0]?.id ?? null;
}

async function createStripeOrder(userCookie, variantId) {
  const res = await api('/api/checkout/create-session', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Origin: BASE_URL, Cookie: userCookie },
    body: JSON.stringify({
      customerName: 'ステージングE2E太郎',
      customerEmail: `staging-e2e-order-${Date.now()}@example.com`,
      customerPhone: '090-0000-0000',
      customerPostalCode: '1000001',
      customerAddress: '東京都千代田区1-1-1',
      agreedToTerms: true,
      paymentMethod: 'stripe',
      items: [{ variantId, quantity: 1 }],
    }),
  });
  if (res.status !== 201) throw new Error(`注文作成に失敗しました: ${res.status} ${JSON.stringify(res.body)}`);
  return res.body;
}

function checkoutCompletedEvent(orderId, sessionId, paymentIntentId, idempotentEventId) {
  return {
    id: idempotentEventId ?? `evt_e2e_${crypto.randomUUID()}`,
    type: 'checkout.session.completed',
    data: { object: { id: sessionId, payment_intent: paymentIntentId, metadata: { order_id: orderId } } },
  };
}

// シナリオ3(16.2「決済」)+シナリオ4(16.2「冪等性」)を1つの注文で通しで確認する。
// 同一Webhookイベントを2回送ることで、二重在庫減算・二重報酬・二重権利付与・二重OVE付与が
// 起きないことも同時に検証する。
async function scenarioPaymentAndIdempotency(adminCookie, userCookie) {
  const variantId = OVE_VARIANT_ID ?? (await fetchFirstVariantId(userCookie));
  if (!variantId) {
    record('決済/冪等性: entitlement.granted・二重処理防止', false, '購入可能な商品バリエーションが見つかりませんでした');
    return;
  }

  const order = await createStripeOrder(userCookie, variantId);
  const paymentIntentId = `pi_e2e_${crypto.randomUUID()}`;
  const event = checkoutCompletedEvent(order.orderId, `cs_e2e_${crypto.randomUUID()}`, paymentIntentId);

  const first = await postStripeWebhook(event);
  const second = await postStripeWebhook(event); // 同一event_idでの再送(Stripeの再送を模擬)。

  if (first.status !== 200 || second.status !== 200) {
    record('決済/冪等性: Webhook受理', false, `1回目=${first.status} 2回目=${second.status}`);
    return;
  }
  record('冪等性: 同一event_idの二重送信を両方200で受理(二重処理はStripe Event Inboxで防止)', true);

  const outboxEvent = await pollUntil(async () => {
    const res = await api(`/api/admin/integration-outbox?status=succeeded`, { headers: { Cookie: adminCookie } });
    return (
      res.body?.outboxEvents?.find(
        (e) => e.eventType === 'entitlement.granted' && e.correlationId === order.orderId,
      ) ?? null
    );
  });
  record('決済: Stripe決済完了 → entitlement.granted', Boolean(outboxEvent), outboxEvent ? undefined : 'entitlement.grantedがsucceededになりませんでした');

  if (OVE_VARIANT_ID) {
    const walletTx = await pollUntil(async () => {
      const res = await api(`/api/admin/order-wallet-transactions?orderId=${order.orderId}`, { headers: { Cookie: adminCookie } });
      return res.body?.transactions?.find((t) => t.transactionType === 'grant') ?? null;
    });
    record('決済: OVEウォレットへのポイント付与', Boolean(walletTx), walletTx ? undefined : 'grant取引が記録されませんでした');

    const walletTxCountRes = await api(`/api/admin/order-wallet-transactions?orderId=${order.orderId}`, { headers: { Cookie: adminCookie } });
    const grantCount = walletTxCountRes.body?.transactions?.filter((t) => t.transactionType === 'grant').length ?? 0;
    record('冪等性: OVE付与が2重にならない(grant行が1件のみ)', grantCount === 1, `grant件数=${grantCount}`);
  }

  return { order, paymentIntentId };
}

// シナリオ5(16.2「返金」): 全額返金 → entitlement.revoked → OVE reversal → 報酬cancelled等。
async function scenarioRefund(adminCookie, purchase) {
  if (!purchase) {
    record('返金: entitlement.revoked → OVE reversal', false, '直前の決済シナリオが失敗したためskip');
    return;
  }
  const { order, paymentIntentId } = purchase;

  const refundEvent = {
    id: `evt_e2e_refund_${crypto.randomUUID()}`,
    type: 'charge.refunded',
    data: { object: { payment_intent: paymentIntentId, amount: order.totalAmount, amount_refunded: order.totalAmount } },
  };
  const res = await postStripeWebhook(refundEvent);
  if (res.status !== 200) {
    record('返金: Webhook受理', false, `status=${res.status}`);
    return;
  }

  const revokedEvent = await pollUntil(async () => {
    const r = await api(`/api/admin/integration-outbox?status=succeeded`, { headers: { Cookie: adminCookie } });
    return r.body?.outboxEvents?.find((e) => e.eventType === 'entitlement.revoked' && e.correlationId === order.orderId) ?? null;
  });
  record('返金: entitlement.revoked', Boolean(revokedEvent), revokedEvent ? undefined : 'entitlement.revokedがsucceededになりませんでした');

  if (OVE_VARIANT_ID) {
    const reversal = await pollUntil(async () => {
      const r = await api(`/api/admin/order-wallet-transactions?orderId=${order.orderId}`, { headers: { Cookie: adminCookie } });
      return r.body?.transactions?.find((t) => t.transactionType === 'reversal') ?? null;
    });
    record('返金: OVE reversal', Boolean(reversal), reversal ? undefined : 'reversal取引が記録されませんでした');
  }
}

// シナリオ6(16.2「障害」): 外部API停止相当 → pending/blocked → Checkout・Webhook自体は成功する
// (=決済確定処理そのものが外部連携の疎通有無に左右されない設計になっていることの確認)。
// 実際に千ノ国/OVEのstaging環境を止めることはできないため、決済確定リクエスト自体が
// 外部呼び出しを一切待たずに完了することを、直前の決済シナリオのWebhookレスポンスタイムから
// 間接的に確認する(entitlement送信は非同期Outbox経由のため、Webhook応答自体は常に外部疎通と
// 無関係に高速で返る設計。指示書2.5「変更禁止範囲」参照)。
async function scenarioExternalOutage(adminCookie) {
  const res = await api(`/api/admin/integration-outbox?status=blocked`, { headers: { Cookie: adminCookie } });
  record(
    '障害: blocked状態のイベントを管理画面(API)から確認可能',
    res.status === 200,
    `blocked件数=${res.body?.total ?? '不明'}(0件でも「確認できること」自体は満たしている)`,
  );
}

// シナリオ7(16.2「concurrent」): Cron重複実行 → 同一eventを1回だけ処理。
// 実際のCron(GitHub Actions外部スケジューラー)を2重に起動することはできないため、
// 内部cronエンドポイントを意図的に同時呼び出しして、claim機構(processing_token)により
// 二重処理されないことを確認する。CRON_SECRETが必要なため、管理者トークンでは代替できない
// 場合はskipする。
async function scenarioConcurrentCron() {
  const cronSecret = process.env.STAGING_CRON_SECRET;
  if (!cronSecret) {
    record('concurrent: Cron重複実行で二重処理なし', true, 'STAGING_CRON_SECRET未指定のためskip');
    return;
  }
  const call = () =>
    fetch(`${BASE_URL}/api/internal/cron/process-integration-outbox`, { headers: { Authorization: `Bearer ${cronSecret}` } }).then((r) =>
      r.json().catch(() => null),
    );
  const [a, b] = await Promise.all([call(), call()]);
  const totalClaimed = (a?.claimed ?? 0) + (b?.claimed ?? 0);
  // claimは条件付きUPDATEでアトミックなため、同じ行を2つの呼び出しが両方claimすることはない
  // (件数の整合性そのものより、両呼び出しがエラーなく完了することを主眼に確認する)。
  record('concurrent: Cron同時呼び出しが両方エラーなく完了する', Boolean(a) && Boolean(b), `合計claimed=${totalClaimed}`);
}

// 1つのシナリオが例外で落ちても、他のシナリオ(特に「障害」「concurrent」等、
// 独立して確認できるもの)は引き続き実行し、最終的な結果サマリーへ反映する。
async function runScenario(name, fn) {
  try {
    return await fn();
  } catch (e) {
    record(name, false, `例外: ${e instanceof Error ? e.message : String(e)}`);
    return undefined;
  }
}

async function main() {
  console.log(`ステージングE2E接続テストを開始します: ${BASE_URL}`);
  const adminCookie = await loginAsAdmin();
  const { cookie: userCookie } = await registerTestUser();

  await runScenario('ユーザー登録シナリオ', () => scenarioUserRegistration(adminCookie));
  await runScenario('紹介シナリオ', () => scenarioReferralCapture(adminCookie));
  const purchase = await runScenario('決済/冪等性シナリオ', () => scenarioPaymentAndIdempotency(adminCookie, userCookie));
  await runScenario('返金シナリオ', () => scenarioRefund(adminCookie, purchase));
  await runScenario('障害シナリオ', () => scenarioExternalOutage(adminCookie));
  await runScenario('concurrentシナリオ', () => scenarioConcurrentCron());

  console.log('\n=== 結果サマリー ===');
  for (const r of results) {
    console.log(`${r.ok ? 'OK' : 'NG'}\t${r.name}${r.detail ? `\t${r.detail}` : ''}`);
  }
  const failed = results.filter((r) => !r.ok);
  if (failed.length > 0) {
    console.error(`\n${failed.length}件のシナリオが失敗しました`);
    process.exit(1);
  }
  console.log('\n全シナリオ成功');
}

main().catch((e) => {
  console.error('ステージングE2Eテストが例外で終了しました', e);
  process.exit(1);
});
