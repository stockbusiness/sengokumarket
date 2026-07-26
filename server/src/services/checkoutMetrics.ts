// 最終安定化指示書Phase10「Checkout性能改善」: 工程別の所要時間・クエリ数を計測し、負荷テスト時に
// P2028(トランザクションタイムアウト)の原因になっているボトルネック工程を特定できるようにする。
// 専用のメトリクス基盤は未導入のため、Vercelのログに残る構造化JSON行として出力するだけにとどめる。
export interface CheckoutMetrics {
  validationMs: number;
  lockMs: number;
  purchaserMs: number;
  pricingMs: number;
  orderWriteMs: number;
  sideEffectsMs: number;
  totalTransactionMs: number;
  // トランザクション内で明示的にawaitしたDB操作呼び出しの回数(N+1検知が目的の概算値であり、
  // 内部で複数のSQL文を発行するヘルパー呼び出しは1件として数える)。
  queryCount: number;
}

export function logCheckoutMetrics(metrics: CheckoutMetrics): void {
  console.log(
    JSON.stringify({
      metric: 'checkout',
      'checkout.validation_ms': metrics.validationMs,
      'checkout.lock_ms': metrics.lockMs,
      'checkout.purchaser_ms': metrics.purchaserMs,
      'checkout.pricing_ms': metrics.pricingMs,
      'checkout.order_write_ms': metrics.orderWriteMs,
      'checkout.side_effects_ms': metrics.sideEffectsMs,
      'checkout.total_transaction_ms': metrics.totalTransactionMs,
      'checkout.query_count': metrics.queryCount,
    }),
  );
}
