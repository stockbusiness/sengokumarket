import { getEffectiveReferralCode } from './referral';

export interface ProductVariant {
  id: string;
  name: string;
  price: number;
  availableStock: number;
}

export interface ProductSummary {
  id: string;
  slug: string;
  name: string;
  category: string;
  basePrice: number;
  images: string[];
  variants: ProductVariant[];
}

export interface ProductDetail extends ProductSummary {
  description: string | null;
}

export class ApiError extends Error {
  code?: string;
  status: number;

  constructor(status: number, code: string | undefined, message: string) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

async function apiFetch<T>(path: string): Promise<T> {
  const res = await fetch(`/api${path}`);
  if (!res.ok) {
    const body = await res.json().catch(() => null);
    throw new ApiError(res.status, body?.error?.code, body?.error?.message ?? `リクエストに失敗しました(${res.status})`);
  }
  return res.json();
}

async function apiPost<T>(path: string, payload: unknown): Promise<T> {
  const res = await fetch(`/api${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
  const body = await res.json().catch(() => null);
  if (!res.ok) {
    throw new ApiError(res.status, body?.error?.code, body?.error?.message ?? `リクエストに失敗しました(${res.status})`);
  }
  return body;
}

async function apiPut<T>(path: string, payload: unknown): Promise<T> {
  const res = await fetch(`/api${path}`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
  const body = await res.json().catch(() => null);
  if (!res.ok) {
    throw new ApiError(res.status, body?.error?.code, body?.error?.message ?? `リクエストに失敗しました(${res.status})`);
  }
  return body;
}

// App.tsxのCookie書き込みuseEffectより先に商品取得のリクエストが飛ぶことがあるため
// (Reactは子コンポーネントのエフェクトを親より先に実行する)、Cookieがまだ無い初回リクエストでも
// サーバー側のrequireReferralOrAuthを通過できるよう、URL/localStorageのref値をクエリに載せる
// (仕様書外の拡張)。
function withReferralQuery(path: string): string {
  const code = getEffectiveReferralCode();
  if (!code) return path;
  const separator = path.includes('?') ? '&' : '?';
  return `${path}${separator}ref=${encodeURIComponent(code)}`;
}

export function fetchProducts() {
  return apiFetch<{ products: ProductSummary[] }>(withReferralQuery('/products'));
}

export function fetchProduct(idOrSlug: string) {
  return apiFetch<{ product: ProductDetail }>(withReferralQuery(`/products/${encodeURIComponent(idOrSlug)}`));
}

export function resolveReferralCode(code: string) {
  return apiFetch<{ found: boolean; referrerName?: string | null; autoApplyCouponCode?: string | null }>(
    `/referrals/resolve?code=${encodeURIComponent(code)}`,
  );
}

export interface CreateCheckoutSessionPayload {
  customerName: string;
  customerEmail: string;
  customerPhone: string;
  customerPostalCode: string;
  customerAddress: string;
  referralCode: string | null;
  couponCode?: string | null;
  // 仕様書外の拡張: 紹介コードの持ち主とは別に、購入者に商品を説明した担当者名(任意)。
  explainerName?: string | null;
  agreedToTerms: boolean;
  items: { variantId: string; quantity: number }[];
  paymentMethod: 'stripe' | 'bank_transfer';
}

export function createCheckoutSession(payload: CreateCheckoutSessionPayload) {
  return apiPost<{
    orderId: string;
    orderNumber: string;
    totalAmount: number;
    stripeCheckoutUrl: string | null;
    paymentMethod: 'stripe' | 'bank_transfer';
    bankTransferInfo?: string;
    bankTransferExpiryDays?: number;
  }>('/checkout/create-session', payload);
}

// 仕様書外の拡張(クーポン機能): 購入前のプレビュー。実際の予約はcreate-session側で行う。
export interface CouponValidationResult {
  valid: boolean;
  message?: string;
  coupon?: { name: string; code: string; discountType: 'fixed' | 'percentage' };
  pricing?: { originalAmount: number; discountAmount: number; finalAmount: number };
}

export function validateCoupon(
  couponCode: string,
  referralCode: string | null,
  items: { variantId: string; quantity: number }[],
) {
  return apiPost<CouponValidationResult>('/checkout/coupons/validate', { couponCode, referralCode, items });
}

export function fetchCheckoutConfig() {
  return apiFetch<{ bankTransferAvailable: boolean; bankTransferInfo: string | null; bankTransferExpiryDays: number }>(
    '/checkout/config',
  );
}

export function fetchCheckoutSessionStatus(sessionId: string) {
  return apiFetch<{ orderNumber: string; paymentStatus: string }>(
    `/checkout/session/${encodeURIComponent(sessionId)}/status`,
  );
}

export function requestPasswordReset(email: string) {
  return apiPost<{ message: string }>('/auth/password-reset/request', { email });
}

export function confirmPasswordReset(token: string, newPassword: string) {
  return apiPost<{ ok: boolean }>('/auth/password-reset/confirm', { token, newPassword });
}

export interface MyOrder {
  id: string;
  orderNumber: string;
  totalAmount: number;
  paymentStatus: string;
  orderStatus: string;
  paidAt: string | null;
  createdAt: string;
  items: { productName: string; variantName: string | null; quantity: number; unitPrice: number; subtotal: number }[];
}

export interface MyNftIssue {
  id: string;
  orderNumber: string;
  productName: string;
  variantName: string | null;
  status: string;
  tokenId: string | null;
  transactionHash: string | null;
  issuedAt: string | null;
}

export interface MyNotice {
  id: string;
  title: string;
  body: string;
  publishedAt: string | null;
  read: boolean;
}

export interface MyWallet {
  walletAddress: string;
  chain: string;
  verified: boolean;
  verifiedAt: string | null;
}

export function fetchMyOrders() {
  return apiFetch<{ orders: MyOrder[] }>('/mypage/orders');
}

export interface MyOrderDetail extends MyOrder {
  customerName: string;
}

export function fetchMyOrder(id: string) {
  return apiFetch<{ order: MyOrderDetail }>(`/mypage/orders/${encodeURIComponent(id)}`);
}

export function fetchMyNftIssues() {
  return apiFetch<{ nftIssues: MyNftIssue[] }>('/mypage/nfts');
}

export function fetchMyNotices() {
  return apiFetch<{ notices: MyNotice[] }>('/mypage/notices');
}

export function markMyNoticeRead(id: string) {
  return apiPost<{ ok: boolean }>(`/mypage/notices/${encodeURIComponent(id)}/read`, undefined);
}

export function fetchMyWallet() {
  return apiFetch<{ wallet: MyWallet | null }>('/mypage/wallet');
}

// 仕様書外の拡張: ウォレット所有確認(署名検証)。まずnonceを発行してもらい、
// ブラウザのウォレット拡張機能でそのメッセージに署名し、署名をサーバーへ送って登録する。
export function requestWalletVerificationNonce(walletAddress: string) {
  return apiPost<{ message: string; expiresAt: string }>('/mypage/wallet/nonce', { walletAddress });
}

export function registerVerifiedWallet(walletAddress: string, signature: string) {
  return apiPost<{ wallet: MyWallet }>('/mypage/wallet', { walletAddress, signature });
}

export interface UpdateMyProfilePayload {
  name: string;
  phone: string;
}

export function updateMyProfile(payload: UpdateMyProfilePayload) {
  return apiPut<{ user: { id: string; name: string; email: string; phone: string | null } }>('/mypage/profile', payload);
}

export function submitAgencyApplication() {
  return apiPost<{ ok: boolean }>('/mypage/agency-application', undefined);
}

export interface LegalDocument {
  slug: string;
  title: string;
  body: string;
}

export function fetchLegalDocument(slug: string) {
  return apiFetch<{ document: LegalDocument }>(`/legal/${encodeURIComponent(slug)}`);
}
