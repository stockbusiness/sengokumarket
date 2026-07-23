// 仕様書外の拡張(外部開発者向け連携ガイドv3.6.78-draft 11.1): このシステムは代理店(agencies)の
// upsertしか扱えないため、既知の代理店ライフサイクル系イベント(またはevent未指定の従来形式)のみ
// 既存のupsert処理へ通す。それ以外(共通顧客HUB関連イベント等)は、対応するデータモデルが
// このシステムに存在しないため、200で受理はしつつ処理をスキップする(相手側の再送ループを防ぐ)。
const AGENCY_LIFECYCLE_EVENTS = new Set([
  'upsert',
  'admin_created',
  'admin_updated',
  'role_updated',
  'approved',
  'promoted',
  'deactivated',
  'deleted',
]);

export function isKnownAgencyLifecycleEvent(event: string): boolean {
  return AGENCY_LIFECYCLE_EVENTS.has(event);
}
