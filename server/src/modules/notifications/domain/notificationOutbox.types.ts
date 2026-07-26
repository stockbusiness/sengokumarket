// 残課題指示書Stage3: 代理店アカウント作成等に伴う通知の永続Outbox。
// 対応イベント種別ごとに、Dispatcherがメール本文を組み立てるために必要な非秘密情報のみを
// payloadへ保存する(パスワード設定用の生トークンは一切含めない。Dispatcher実行時に発行する)。
export type NotificationEventType = 'agency_account_setup' | 'agency_access_granted' | 'wallet_claim_reissued';

export interface AgencyAccountSetupPayload {
  name: string;
  userId: string;
}

export interface AgencyAccessGrantedPayload {
  name: string;
}

// Wallet Claim本番前安定化指示書(2026-07-25)Phase1・Phase11: 管理者によるClaim URL再発行。
// 生Token・生URLはpayloadへ保存しない。新Tokenの発行自体もDispatcher実行時に行う
// (agency_account_setupのpassword reset tokenと同じ設計)。
export interface WalletClaimReissuedPayload {
  orderId: string;
}

export interface EnqueueNotificationInput {
  eventType: NotificationEventType;
  recipient: string;
  payload: AgencyAccountSetupPayload | AgencyAccessGrantedPayload | WalletClaimReissuedPayload;
}
