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
