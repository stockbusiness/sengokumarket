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

async function apiFetch<T>(path: string): Promise<T> {
  const res = await fetch(`/api${path}`);
  if (!res.ok) {
    const body = await res.json().catch(() => null);
    throw new Error(body?.error?.message ?? `リクエストに失敗しました(${res.status})`);
  }
  return res.json();
}

export function fetchProducts() {
  return apiFetch<{ products: ProductSummary[] }>('/products');
}

export function fetchProduct(idOrSlug: string) {
  return apiFetch<{ product: ProductDetail }>(`/products/${encodeURIComponent(idOrSlug)}`);
}
