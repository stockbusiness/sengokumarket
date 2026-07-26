// 残課題指示書Stage3: 代理店アカウント作成等に伴う通知の永続Outbox。
// 対応イベント種別ごとに、Dispatcherがメール本文を組み立てるために必要な非秘密情報のみを
// payloadへ保存する(パスワード設定用の生トークンは一切含めない。Dispatcher実行時に発行する)。
export type NotificationEventType =
  | 'agency_account_setup'
  | 'agency_access_granted'
  | 'wallet_claim_reissued'
  // Wallet Claim本番前安定化指示書(2026-07-25)Phase11(13章「通知全般のOutbox化」): 残る
  // 同期メール送信をすべてこのOutboxへ統一する。Stripe Webhook・銀行振込入金確認は
  // 通知予定作成のみを行い、Resend完了を待たない(13.2・13.4)。
  | 'purchase_complete'
  | 'guest_password_setup'
  | 'bank_transfer_instructions'
  | 'password_reset'
  | 'cart_abandoned'
  | 'admin_account_setup'
  | 'wallet_reminder';

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

// 注文の内容自体(明細・金額等)はDispatcher実行時に注文から再取得する(13.2「Stripe
// Webhook・銀行振込入金確認では通知予定作成だけを行う」)。受取Claim URLの生Tokenも
// wallet_claim_reissuedと同じくDispatcher実行時にのみ発行する(13.3「Tokenを含む通知」)。
export interface PurchaseCompletePayload {
  orderId: string;
}

export interface GuestPasswordSetupPayload {
  name: string;
  userId: string;
}

export interface BankTransferInstructionsPayload {
  orderId: string;
}

export interface PasswordResetPayload {
  name: string;
  userId: string;
}

export interface CartAbandonedPayload {
  orderId: string;
}

// roleLabelではなくroleそのものを保存し、表示用ラベルへの変換はDispatcher側で行う
// (ラベル文言の変更が過去にenqueue済みの通知へ影響しないようにするため)。
export interface AdminAccountSetupPayload {
  name: string;
  userId: string;
  role: string;
}

export interface WalletReminderPayload {
  nftIssueId: string;
}

export interface EnqueueNotificationInput {
  eventType: NotificationEventType;
  recipient: string;
  payload:
    | AgencyAccountSetupPayload
    | AgencyAccessGrantedPayload
    | WalletClaimReissuedPayload
    | PurchaseCompletePayload
    | GuestPasswordSetupPayload
    | BankTransferInstructionsPayload
    | PasswordResetPayload
    | CartAbandonedPayload
    | AdminAccountSetupPayload
    | WalletReminderPayload;
}
