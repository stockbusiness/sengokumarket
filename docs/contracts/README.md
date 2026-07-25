# docs/contracts

千ノ国ウォレット側と合意する外部連携イベントのJSON契約サンプルを置く。

## fixtures/

- `digital-collectible-granted.v1.json` — digital_collectible対象商品のNftIssue単位
  `entitlement.granted`イベント(Common Event API `POST <wallet-api>/api/integrations/events`
  へ送信する実際のリクエストボディ)のサンプル。
- `digital-collectible-revoked.v1.json` — 同上の`entitlement.revoked`版(返金・取消時)。

いずれも実際の値ではなくキー構造の一致を検証する目的のサンプルであり、
`event_id`・`occurred_at`・各種UUID等は呼び出しごとに異なる。
`server/src/services/integrationOutboxDispatcher.digitalCollectible.test.ts`が、
実際の送信payloadとこのFixtureのキー構造が一致することを検証する。
