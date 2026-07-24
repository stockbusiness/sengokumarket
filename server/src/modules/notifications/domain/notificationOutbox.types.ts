// 残課題指示書Stage3: 代理店アカウント作成等に伴う通知の永続Outbox。
// 対応イベント種別ごとに、Dispatcherがメール本文を組み立てるために必要な非秘密情報のみを
// payloadへ保存する(パスワード設定用の生トークンは一切含めない。Dispatcher実行時に発行する)。
export type NotificationEventType = 'agency_account_setup' | 'agency_access_granted';

export interface AgencyAccountSetupPayload {
  name: string;
  userId: string;
}

export interface AgencyAccessGrantedPayload {
  name: string;
}

export interface EnqueueNotificationInput {
  eventType: NotificationEventType;
  recipient: string;
  payload: AgencyAccountSetupPayload | AgencyAccessGrantedPayload;
}
