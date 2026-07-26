import crypto from 'crypto';
import { appConfig } from '../shared/config/appConfig';

// 最終安定化指示書Phase2「Notification Tokenの安定化」: 同じNotification Outbox Eventの
// retryでは必ず同じTokenを生成する(送信直後に届いたメールのURLが、後続のretryで無効化
// されてしまう問題を防ぐ)。event_id(retryをまたいで不変)を入力に含めることで、同一Eventの
// 再試行は常に同じ値を導出し、新しいNotification Event(=明示的な新規再発行要求)は
// 別の値になる。
export const MIN_SECRET_BYTES = 32;

export interface DeterministicTokenInput {
  eventId: string;
  subjectId: string;
  tokenVersion: number;
  purpose: string;
}

function isSecretConfigured(secret: string | undefined): secret is string {
  return typeof secret === 'string' && Buffer.byteLength(secret, 'utf8') >= MIN_SECRET_BYTES;
}

// NOTIFICATION_TOKEN_DERIVATION_SECRETが未設定・短すぎる場合はnullを返す(呼び出し元は
// 既存の都度ランダム発行にフォールバックする)。この鍵は既に本番稼働中の通知経路にも影響するため、
// 未設定を理由に例外を投げて送信自体を止めてはならない。
export function deriveDeterministicToken(input: DeterministicTokenInput): string | null {
  const secret = appConfig.notificationTokenDerivationSecret;
  if (!isSecretConfigured(secret)) return null;

  return crypto
    .createHmac('sha256', secret)
    .update(`${input.eventId}:${input.subjectId}:${input.tokenVersion}:${input.purpose}`)
    .digest('hex');
}
