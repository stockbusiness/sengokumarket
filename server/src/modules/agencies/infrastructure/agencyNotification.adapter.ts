import { createPasswordResetToken } from '../../../services/passwordReset';
import { sendAgencyAccessGrantedEmail, sendAgencyAccountSetupEmail } from '../../../services/mailTemplates';
import type { AgencyNotification } from '../domain/agency.types';

// メール送信(および設定リンク用トークンの発行)は、代理店upsertの本体トランザクションが
// commitされた後に行う(指示書8.4「メール送信自体はトランザクション外」)。送信やトークン発行が
// 失敗しても、既にcommit済みの代理店・ログインユーザー作成は巻き戻さない。
export async function dispatchAgencyNotification(notification: AgencyNotification | null): Promise<void> {
  if (!notification) return;

  if (notification.type === 'access_granted') {
    await sendAgencyAccessGrantedEmail(notification.email, notification.name);
    return;
  }

  const token = await createPasswordResetToken(notification.userId);
  await sendAgencyAccountSetupEmail(notification.email, notification.name, token);
}
