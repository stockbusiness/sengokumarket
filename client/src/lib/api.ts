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
  imageUrl: string | null;
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

export function fetchProducts() {
  return apiFetch<{ products: ProductSummary[] }>('/products');
}

export function fetchProduct(idOrSlug: string) {
  return apiFetch<{ product: ProductDetail }>(`/products/${encodeURIComponent(idOrSlug)}`);
}

export function resolveReferralCode(code: string) {
  return apiFetch<{ found: boolean; referrerName?: string | null }>(`/referrals/resolve?code=${encodeURIComponent(code)}`);
}

export interface CreateCheckoutSessionPayload {
  customerName: string;
  customerEmail: string;
  customerPhone: string;
  customerPostalCode: string;
  customerAddress: string;
  referralCode: string | null;
  agreedToTerms: boolean;
  items: { variantId: string; quantity: number }[];
}

export function createCheckoutSession(payload: CreateCheckoutSessionPayload) {
  return apiPost<{ orderId: string; orderNumber: string; totalAmount: number; stripeCheckoutUrl: string | null }>(
    '/checkout/create-session',
    payload,
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
}

export function fetchMyOrders() {
  return apiFetch<{ orders: MyOrder[] }>('/mypage/orders');
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

export function updateMyWallet(walletAddress: string) {
  return apiPost<{ wallet: MyWallet }>('/mypage/wallet', { walletAddress, chain: 'polygon' });
}

export interface UpdateMyProfilePayload {
  name: string;
  phone: string;
}

export function updateMyProfile(payload: UpdateMyProfilePayload) {
  return apiPut<{ user: { id: string; name: string; email: string; phone: string | null } }>('/mypage/profile', payload);
}

export interface LegalDocument {
  slug: string;
  title: string;
  body: string;
}

export function fetchLegalDocument(slug: string) {
  return apiFetch<{ document: LegalDocument }>(`/legal/${encodeURIComponent(slug)}`);
}
