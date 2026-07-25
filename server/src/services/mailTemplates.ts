// 保守性改善Phase 7: 実装はmodules/notifications/へ分割済み。既存の呼び出し元(8ファイル)・
// vi.mockによるテスト差し替え(4ファイル)を変更せずに済むよう、このファイルは元と同じ関数名で
// 「テンプレート組み立て→送信」を行う薄いラッパーとしてのみ残す。
import type { Order, OrderItem } from '@prisma/client';
import { sendNotification } from '../modules/notifications/application/sendNotification.usecase';
import { buildPurchaseCompleteEmail } from '../modules/notifications/templates/purchaseComplete';
import { buildCartAbandonedEmail } from '../modules/notifications/templates/cartAbandoned';
import { buildBankTransferInstructionsEmail } from '../modules/notifications/templates/bankTransfer';
import {
  buildAdminAccountSetupEmail,
  buildAgencyAccessGrantedEmail,
  buildAgencyAccountSetupEmail,
  buildGuestPasswordSetupEmail,
} from '../modules/notifications/templates/passwordSetup';
import { buildPasswordResetEmail } from '../modules/notifications/templates/passwordReset';
import { buildWalletReminderEmail } from '../modules/notifications/templates/walletReminder';
import { buildWalletClaimReissuedEmail } from '../modules/notifications/templates/walletClaimReissued';

export async function sendPurchaseCompleteEmail(order: Order, items: OrderItem[], walletClaimToken?: string | null): Promise<void> {
  await sendNotification(await buildPurchaseCompleteEmail(order, items, walletClaimToken ?? null));
}

export async function sendBankTransferInstructionsEmail(order: Order, items: OrderItem[], bankInfo: string, expiryDays: number): Promise<void> {
  await sendNotification(buildBankTransferInstructionsEmail(order, items, bankInfo, expiryDays));
}

export async function sendCartAbandonedEmail(order: Order, items: OrderItem[], productSlug: string | null): Promise<void> {
  await sendNotification(buildCartAbandonedEmail(order, items, productSlug));
}

export async function sendGuestPasswordSetupEmail(email: string, name: string, token: string): Promise<void> {
  await sendNotification(buildGuestPasswordSetupEmail(email, name, token));
}

export async function sendAgencyAccountSetupEmail(email: string, name: string, token: string): Promise<void> {
  await sendNotification(buildAgencyAccountSetupEmail(email, name, token));
}

export async function sendAgencyAccessGrantedEmail(email: string, name: string): Promise<void> {
  await sendNotification(buildAgencyAccessGrantedEmail(email, name));
}

export async function sendAdminAccountSetupEmail(email: string, name: string, token: string, roleLabel: string): Promise<void> {
  await sendNotification(buildAdminAccountSetupEmail(email, name, token, roleLabel));
}

export async function sendWalletReminderEmail(email: string, name: string, orderNumber: string): Promise<void> {
  await sendNotification(buildWalletReminderEmail(email, name, orderNumber));
}

export async function sendPasswordResetEmail(email: string, name: string, token: string): Promise<void> {
  await sendNotification(buildPasswordResetEmail(email, name, token));
}

export async function sendWalletClaimReissuedEmail(email: string, name: string, claimUrl: string): Promise<void> {
  await sendNotification(buildWalletClaimReissuedEmail(email, name, claimUrl));
}
