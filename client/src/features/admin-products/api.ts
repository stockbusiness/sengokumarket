import { adminFetch, adminSend, adminSendForm } from '../../shared/api/adminClient';

export interface AdminProductVariant {
  id: string;
  name: string;
  sku: string | null;
  price: number;
  stock: number;
  reservedStock: number;
}

// 本番安定化指示書Stage6(9.1〜9.5): 商品ごとの権利付与ルーティング設定。1商品から
// 複数の送信先(entitlementTargetSystemKey)へ設定できる(1:N化)。
export interface AdminProductIntegrationRule {
  id: string;
  productId: string;
  productCode: string | null;
  entitlementTargetSystemKey: string | null;
  entitlementType: string | null;
  rewardRuleId: string | null;
  rewardAmountPerUnit: number | null;
  rewardCalculationMode: string | null;
  revokeOnRefund: boolean;
  requireCommonUserId: boolean;
  requireSalesAgentId: boolean;
  requireClosingAgentId: boolean;
  requireReferralSessionKey: boolean;
  enabled: boolean;
  // Wallet Claim本番前安定化指示書(2026-07-25)Phase10「ProductIntegrationRule入力制約」:
  // entitlementType=digital_collectibleの必須項目。
  assetCode: string | null;
  collectibleRarity: string | null;
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
  // 一覧取得(fetchAdminProducts)では含まれない(単体取得fetchAdminProductでのみ返る)。
  integrationRules?: AdminProductIntegrationRule[];
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

// 本番安定化指示書Stage6(9.5): 商品編集画面から連携ルールを管理するためのAPI。
export interface IntegrationRuleRequest {
  productCode?: string | null;
  entitlementTargetSystemKey?: string | null;
  entitlementType?: string | null;
  rewardRuleId?: string | null;
  rewardAmountPerUnit?: number | null;
  rewardCalculationMode?: string | null;
  revokeOnRefund?: boolean;
  requireCommonUserId?: boolean;
  requireSalesAgentId?: boolean;
  requireClosingAgentId?: boolean;
  requireReferralSessionKey?: boolean;
  enabled?: boolean;
  assetCode?: string | null;
  collectibleRarity?: string | null;
}

export function fetchAdminProductIntegrationRules(productId: string) {
  return adminFetch<{ rules: AdminProductIntegrationRule[] }>(`/products/${productId}/integration-rules`);
}

export function createAdminProductIntegrationRule(productId: string, payload: IntegrationRuleRequest) {
  return adminSend<{ rule: AdminProductIntegrationRule }>('POST', `/products/${productId}/integration-rules`, payload);
}

export function updateAdminProductIntegrationRule(productId: string, ruleId: string, payload: IntegrationRuleRequest) {
  return adminSend<{ rule: AdminProductIntegrationRule }>('PATCH', `/products/${productId}/integration-rules/${ruleId}`, payload);
}
