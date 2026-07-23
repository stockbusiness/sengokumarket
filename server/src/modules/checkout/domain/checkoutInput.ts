import { HttpError } from '../../../lib/httpError';
import { isValidEmail } from '../../../lib/validation';
import type { CreatePendingOrderInput } from './checkout.types';

function isNonEmptyString(v: unknown): v is string {
  return typeof v === 'string' && v.trim().length > 0;
}

// リクエストボディの形式検証のみを行う(DBアクセスを伴わない純粋な入力検証)。
export function validateCreatePendingOrderInput(body: unknown): CreatePendingOrderInput {
  const b = body as Record<string, unknown>;

  if (!isNonEmptyString(b?.customerName)) throw new HttpError(400, 'VALIDATION_ERROR', '氏名を入力してください');
  if (!isNonEmptyString(b?.customerEmail) || !isValidEmail(b.customerEmail as string)) {
    throw new HttpError(400, 'VALIDATION_ERROR', 'メールアドレスを正しく入力してください');
  }
  if (!isNonEmptyString(b?.customerPhone)) throw new HttpError(400, 'VALIDATION_ERROR', '電話番号を入力してください');
  if (!isNonEmptyString(b?.customerPostalCode)) throw new HttpError(400, 'VALIDATION_ERROR', '郵便番号を入力してください');
  if (!isNonEmptyString(b?.customerAddress)) throw new HttpError(400, 'VALIDATION_ERROR', '住所を入力してください');
  if (b?.agreedToTerms !== true) {
    throw new HttpError(400, 'TERMS_NOT_AGREED', '利用規約・返金ポリシーへの同意が必要です');
  }
  if (!Array.isArray(b?.items) || b.items.length === 0) {
    throw new HttpError(400, 'VALIDATION_ERROR', 'カートが空です');
  }
  const paymentMethod = b?.paymentMethod === 'bank_transfer' ? 'bank_transfer' : 'stripe';
  const items = (b.items as unknown[]).map((raw) => {
    const item = raw as Record<string, unknown>;
    if (!isNonEmptyString(item?.variantId) || !Number.isInteger(item.quantity) || (item.quantity as number) < 1) {
      throw new HttpError(400, 'VALIDATION_ERROR', 'カートの内容が不正です');
    }
    return { variantId: item.variantId as string, quantity: item.quantity as number };
  });

  return {
    customerName: (b.customerName as string).trim(),
    customerEmail: (b.customerEmail as string).trim(),
    customerPhone: (b.customerPhone as string).trim(),
    customerPostalCode: (b.customerPostalCode as string).trim(),
    customerAddress: (b.customerAddress as string).trim(),
    referralCode: isNonEmptyString(b.referralCode) ? (b.referralCode as string).trim() : null,
    couponCode: isNonEmptyString(b.couponCode) ? (b.couponCode as string).trim().toUpperCase() : null,
    explainerName: isNonEmptyString(b.explainerName) ? (b.explainerName as string).trim() : null,
    agreedToTerms: true,
    items,
    paymentMethod,
  };
}
