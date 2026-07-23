import { adminFetch, adminSend, adminSendForm } from '../../shared/api/adminClient';

export interface AdminProductVariant {
  id: string;
  name: string;
  sku: string | null;
  price: number;
  stock: number;
  reservedStock: number;
}
export interface AdminProduct {
  id: string;
  name: string;
  slug: string;
  description: string | null;
  category: string;
  itemType: string;
  salesModel: string;
  basePrice: number;
  status: string;
  images: string[];
  variants: AdminProductVariant[];
}

export function fetchAdminProducts() {
  return adminFetch<{ products: AdminProduct[] }>('/products');
}

export function fetchAdminProduct(id: string) {
  return adminFetch<{ product: AdminProduct }>(`/products/${id}`);
}

// 読取型(AdminProduct)と送信型を分離する(Partial<Omit<...>>による過剰送信を避けるため)。
export interface NewVariantRequest {
  name: string;
  sku?: string | null;
  price: number;
  stock?: number;
}

export interface UpdateVariantRequest {
  id: string;
  name?: string;
  sku?: string | null;
  price?: number;
  stock?: number;
}

export interface CreateProductRequest {
  name: string;
  slug: string;
  description?: string | null;
  category: string;
  itemType: string;
  salesModel?: string;
  basePrice: number;
  status?: string;
  images?: string[];
  variants?: NewVariantRequest[];
}

export interface UpdateProductRequest {
  name?: string;
  description?: string | null;
  category?: string;
  itemType?: string;
  salesModel?: string;
  status?: string;
  basePrice?: number;
  images?: string[];
  variants?: (UpdateVariantRequest | NewVariantRequest)[];
}

export function createAdminProduct(payload: CreateProductRequest) {
  return adminSend<{ product: AdminProduct }>('POST', '/products', payload);
}

export function updateAdminProduct(id: string, payload: UpdateProductRequest) {
  return adminSend<{ product: AdminProduct }>('PUT', `/products/${id}`, payload);
}

export function deleteAdminProduct(id: string) {
  return adminSend<{ success: true }>('DELETE', `/products/${id}`);
}

export function deleteAdminProductVariant(productId: string, variantId: string) {
  return adminSend<{ product: AdminProduct }>('DELETE', `/products/${productId}/variants/${variantId}`);
}

// 画像ファイルはJSONで送れないため、adminSendとは別にmultipart/form-dataで送信する。
export function uploadAdminProductImage(file: File) {
  const formData = new FormData();
  formData.append('image', file);
  return adminSendForm<{ url: string }>('/products/upload-image', formData, 'アップロードに失敗しました');
}
