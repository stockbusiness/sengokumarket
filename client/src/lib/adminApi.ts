import { ApiError } from './api';

async function adminFetch<T>(path: string): Promise<T> {
  const res = await fetch(`/api/admin${path}`);
  const body = await res.json().catch(() => null);
  if (!res.ok) {
    throw new ApiError(res.status, body?.error?.code, body?.error?.message ?? `リクエストに失敗しました(${res.status})`);
  }
  return body;
}

async function adminSend<T>(method: 'POST' | 'PUT' | 'PATCH' | 'DELETE', path: string, payload?: unknown): Promise<T> {
  const res = await fetch(`/api/admin${path}`, {
    method,
    headers: { 'Content-Type': 'application/json' },
    body: payload !== undefined ? JSON.stringify(payload) : undefined,
  });
  if (res.status === 204) return undefined as T;
  const body = await res.json().catch(() => null);
  if (!res.ok) {
    throw new ApiError(res.status, body?.error?.code, body?.error?.message ?? `リクエストに失敗しました(${res.status})`);
  }
  return body;
}

// --- Dashboard ---
export interface AdminDashboard {
  totalSales: number;
  orderCount: number;
  paidCount: number;
  nftPendingCount: number;
  walletMissingCount: number;
  stockByVariant: { productName: string; variantName: string; stock: number; reservedStock: number; availableStock: number }[];
  referralSales: number;
  agencyTop5: { agencyId: string; agencyName: string; totalSales: number }[];
  pendingCommissionTotal: number;
  alerts: { partialRefundCount: number; commissionRecoveryCount: number };
}

export function fetchAdminDashboard() {
  return adminFetch<AdminDashboard>('/dashboard');
}

export interface SalesTrendMonth {
  month: string;
  totalSales: number;
  orderCount: number;
}

export function fetchAdminSalesTrend(months = 6) {
  return adminFetch<{ trend: SalesTrendMonth[] }>(`/dashboard/sales-trend?months=${months}`);
}

// --- Products ---
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
  basePrice: number;
  status: string;
  images: string[];
  variants: AdminProductVariant[];
}

export function fetchAdminProducts() {
  return adminFetch<{ products: AdminProduct[] }>('/products');
}

type ProductPayload = Partial<Omit<AdminProduct, 'variants'>> & { variants?: Partial<AdminProductVariant>[] };

export function createAdminProduct(payload: ProductPayload) {
  return adminSend<{ product: AdminProduct }>('POST', '/products', payload);
}

export function updateAdminProduct(id: string, payload: ProductPayload) {
  return adminSend<{ product: AdminProduct }>('PUT', `/products/${id}`, payload);
}

// --- Orders ---
export interface AdminOrder {
  id: string;
  orderNumber: string;
  customerName: string;
  customerEmail: string;
  totalAmount: number;
  paymentStatus: string;
  orderStatus: string;
  paymentMethod: string;
  paidAt: string | null;
  referralCode: string | null;
  agencyName: string | null;
  referrerName: string | null;
  commissionAmount: number;
  commissionStatus: string;
  adminNote: string | null;
  createdAt: string;
}

export function fetchAdminOrders() {
  return adminFetch<{ orders: AdminOrder[] }>('/orders');
}

export function updateAdminOrder(id: string, payload: { orderStatus?: string; adminNote?: string }) {
  return adminSend<{ order: AdminOrder }>('PUT', `/orders/${id}`, payload);
}

export function buildOrdersExportCsvUrl() {
  return '/api/admin/orders/export.csv';
}

export function confirmBankTransferPayment(id: string) {
  return adminSend<{ order: AdminOrder }>('POST', `/orders/${id}/confirm-bank-transfer`, undefined);
}

// --- 銀行振込設定(仕様書外の拡張) ---
export interface BankTransferSettings {
  enabled: boolean;
  info: string;
}

export function fetchBankTransferSettings() {
  return adminFetch<BankTransferSettings>('/bank-transfer-settings');
}

export function updateBankTransferSettings(payload: BankTransferSettings) {
  return adminSend<BankTransferSettings>('PUT', '/bank-transfer-settings', payload);
}

// --- NFT issues ---
export interface AdminNftIssue {
  id: string;
  orderNumber: string;
  customerName: string;
  productName: string;
  variantName: string | null;
  walletAddress: string | null;
  status: string;
  tokenId: string | null;
  transactionHash: string | null;
  issuedAt: string | null;
  adminNote: string | null;
}

export function fetchAdminNftIssues(status?: string) {
  return adminFetch<{ nftIssues: AdminNftIssue[] }>(`/nft-issues${status ? `?status=${status}` : ''}`);
}

export function updateAdminNftIssue(
  id: string,
  payload: { status?: string; tokenId?: string; transactionHash?: string; adminNote?: string },
) {
  return adminSend<{ nftIssue: AdminNftIssue }>('PUT', `/nft-issues/${id}`, payload);
}

// --- Wallet missing ---
export interface AdminWalletMissing {
  customerName: string;
  customerEmail: string;
  orderNumber: string;
  productName: string;
  purchasedAt: string;
}

export function fetchAdminWalletMissing() {
  return adminFetch<{ walletMissing: AdminWalletMissing[] }>('/wallet-missing');
}

// --- Notices ---
export interface AdminNotice {
  id: string;
  title: string;
  body: string;
  status: string;
  publishedAt: string | null;
}

export function fetchAdminNotices() {
  return adminFetch<{ notices: AdminNotice[] }>('/notices');
}
export function createAdminNotice(payload: { title: string; body: string }) {
  return adminSend<{ notice: AdminNotice }>('POST', '/notices', payload);
}
export function updateAdminNotice(id: string, payload: { title?: string; body?: string; status?: string }) {
  return adminSend<{ notice: AdminNotice }>('PUT', `/notices/${id}`, payload);
}
export function deleteAdminNotice(id: string) {
  return adminSend<void>('DELETE', `/notices/${id}`);
}

// --- Agencies / Influencers ---
export function fetchAdminAgencies() {
  return adminFetch<{ agencies: { id: string; name: string }[] }>('/agencies');
}

export interface AdminAgencyDetail {
  id: string;
  name: string;
  code: string;
  externalId: string | null;
  parentAgencyName: string | null;
  status: string;
  defaultCommissionRate: number;
  loginEmail: string | null;
}

export function fetchAdminAgenciesDetail() {
  return adminFetch<{ agencies: AdminAgencyDetail[] }>('/agencies/detail');
}

export function syncAgenciesFromExternalSystem() {
  return adminSend<{ agenciesSynced: number; applicationsApproved: number }>('POST', '/agencies/sync-external');
}
export function fetchAdminInfluencers(agencyId?: string) {
  return adminFetch<{ influencers: { id: string; name: string }[] }>(
    `/influencers${agencyId ? `?agency_id=${agencyId}` : ''}`,
  );
}

// --- Referral links ---
export interface AdminReferralLink {
  id: string;
  code: string;
  url: string;
  agencyName: string | null;
  influencerName: string | null;
  resolvedCommissionRate: number;
  status: string;
  createdAt: string;
}

export function fetchAdminReferralLinks() {
  return adminFetch<{ referralLinks: AdminReferralLink[] }>('/referral-links');
}

export function fetchAdminLandingOptions() {
  return adminFetch<{ options: { path: string; label: string }[] }>('/referral-links/landing-options');
}

export interface CreateReferralLinkPayload {
  agency: { id: string } | { new_name: string; default_commission_rate?: number };
  influencer: { id: string } | { new_name: string } | null;
  commission_rate: number | null;
  landing_path: string;
}

export function createAdminReferralLink(payload: CreateReferralLinkPayload) {
  return adminSend<{ referralLink: AdminReferralLink }>('POST', '/referral-links', payload);
}

export function updateAdminReferralLinkStatus(id: string, status: 'active' | 'inactive') {
  return adminSend<{ referralLink: { id: string; status: string } }>('PUT', `/referral-links/${id}/status`, { status });
}

// --- Referrals summary / commissions ---
export interface AdminReferralSummaryRow {
  orderCount: number;
  paidCount: number;
  salesAmount: number;
  commissionAmount: number;
}
export interface AdminReferralSummary {
  byAgency: (AdminReferralSummaryRow & { agencyId: string; agencyName: string })[];
  byInfluencer: (AdminReferralSummaryRow & { influencerId: string; influencerName: string; agencyName: string | null })[];
}

export function fetchAdminReferralsSummary() {
  return adminFetch<AdminReferralSummary>('/referrals/summary');
}

export interface AdminCommission {
  id: string;
  orderNumber: string;
  customerName: string;
  agencyName: string | null;
  influencerName: string | null;
  referralCode: string | null;
  baseAmount: number;
  commissionRate: number;
  commissionAmount: number;
  status: string;
  approvedAt: string | null;
  paidAt: string | null;
  adminNote: string | null;
}

export function fetchAdminCommissions(status?: string) {
  return adminFetch<{ commissions: AdminCommission[] }>(`/referrals/commissions${status ? `?status=${status}` : ''}`);
}

export function updateAdminCommission(id: string, payload: { status?: string; adminNote?: string }) {
  return adminSend<{ commission: AdminCommission }>('PUT', `/referrals/commissions/${id}`, payload);
}

export function buildReferralExportCsvUrl(params: { from: string; to: string; status: string; markApproved: boolean }) {
  const q = new URLSearchParams({
    from: params.from,
    to: params.to,
    status: params.status,
    mark_approved: String(params.markApproved),
  });
  return `/api/admin/referrals/export.csv?${q.toString()}`;
}

// --- Settings (Stripe/Resend, 仕様書外の拡張) ---
export interface AdminSettingInfo {
  configured: boolean;
  masked: string | null;
}
export interface AdminSettings {
  stripe_secret_key: AdminSettingInfo;
  stripe_webhook_secret: AdminSettingInfo;
  stripe_public_key: AdminSettingInfo;
  resend_api_key: AdminSettingInfo;
  mail_from: AdminSettingInfo;
  agency_api_key: AdminSettingInfo;
  external_agency_system_base_url: AdminSettingInfo;
  external_agency_system_api_key: AdminSettingInfo;
}

export function fetchAdminSettings() {
  return adminFetch<{ settings: AdminSettings }>('/settings');
}

export function updateAdminSettings(payload: Partial<Record<keyof AdminSettings, string>>) {
  return adminSend<{ settings: AdminSettings }>('PUT', '/settings', payload);
}

export interface ConnectionTestResult {
  ok: boolean;
  message: string;
}

export function testStripeConnection(stripeSecretKey: string) {
  return adminSend<ConnectionTestResult>('POST', '/settings/test/stripe', { stripe_secret_key: stripeSecretKey });
}

export function testResendConnection(resendApiKey: string, mailFrom: string, to: string) {
  return adminSend<ConnectionTestResult>('POST', '/settings/test/resend', {
    resend_api_key: resendApiKey,
    mail_from: mailFrom,
    to,
  });
}

export function testExternalAgencyConnection(baseUrl: string, apiKey: string) {
  return adminSend<ConnectionTestResult>('POST', '/settings/test/external-agency', {
    external_agency_system_base_url: baseUrl,
    external_agency_system_api_key: apiKey,
  });
}

export function testAgencyKeyConnection(agencyApiKey: string) {
  return adminSend<ConnectionTestResult>('POST', '/settings/test/agency-key', { agency_api_key: agencyApiKey });
}

// --- CSV商品インポート ---
export interface ImportRowResult {
  line: number;
  slug: string | null;
  sku: string | null;
  action: 'create_product_and_variant' | 'create_variant' | 'update_variant' | 'error';
  errors: string[];
}
export interface ImportResult {
  results: ImportRowResult[];
  errorCount: number;
  successCount: number;
}

export function importProductsCsv(csvContent: string, dryRun: boolean) {
  return adminSend<ImportResult>('POST', '/import-products', { csvContent, dryRun });
}

// --- 法務ページ ---
export interface AdminLegalDocument {
  slug: string;
  title: string;
  body: string;
  updatedAt: string;
}

export function fetchAdminLegalDocuments() {
  return adminFetch<{ documents: AdminLegalDocument[] }>('/legal');
}

export function updateAdminLegalDocument(slug: string, payload: { title: string; body: string }) {
  return adminSend<{ document: AdminLegalDocument }>('PUT', `/legal/${slug}`, payload);
}

// --- 監査ログ(仕様書外の拡張) ---
export interface AdminAuditLogEntry {
  id: string;
  actorEmail: string;
  actorRole: string;
  method: string;
  path: string;
  requestBody: unknown;
  statusCode: number;
  createdAt: string;
}

export function fetchAdminAuditLogs(page: number) {
  return adminFetch<{ logs: AdminAuditLogEntry[]; total: number; page: number; pageSize: number }>(`/audit-logs?page=${page}`);
}

// --- 管理者アカウント管理(仕様書外の拡張) ---
export interface AdminUser {
  id: string;
  name: string;
  email: string;
  role: 'admin' | 'admin_viewer' | 'staff';
  createdAt: string;
}

export function fetchAdminUsers() {
  return adminFetch<{ adminUsers: AdminUser[] }>('/admin-users');
}

export function createAdminUser(payload: { name: string; email: string; role: AdminUser['role'] }) {
  return adminSend<{ adminUser: AdminUser }>('POST', '/admin-users', payload);
}

export function updateAdminUserRole(id: string, role: AdminUser['role']) {
  return adminSend<{ adminUser: AdminUser }>('PUT', `/admin-users/${id}/role`, { role });
}

export function resendAdminUserSetupEmail(id: string) {
  return adminSend<{ success: true }>('POST', `/admin-users/${id}/resend-setup-email`);
}

export function deleteAdminUser(id: string) {
  return adminSend<{ success: true }>('DELETE', `/admin-users/${id}`);
}

// --- クーポン管理(仕様書外の拡張) ---
export interface AdminCoupon {
  id: string;
  code: string;
  name: string;
  description: string | null;
  discountType: 'fixed' | 'percentage';
  discountAmount: number | null;
  discountPercentage: number | null;
  maximumDiscountAmount: number | null;
  minimumOrderAmount: number | null;
  startsAt: string | null;
  expiresAt: string | null;
  totalUsageLimit: number | null;
  perCustomerUsageLimit: number;
  usedCount: number;
  reservedCount: number;
  productScopeType: string;
  agencyScopeType: string;
  customerScopeType: string;
  isActive: boolean;
  restoreOnCancel: boolean;
  createdAt: string;
}

export interface AdminCouponPayload {
  name: string;
  code?: string | null;
  description?: string | null;
  discountType: 'fixed' | 'percentage';
  discountAmount?: number | null;
  discountPercentage?: number | null;
  maximumDiscountAmount?: number | null;
  minimumOrderAmount?: number | null;
  startsAt?: string | null;
  expiresAt?: string | null;
  totalUsageLimit?: number | null;
  perCustomerUsageLimit?: number;
  isActive?: boolean;
}

export function fetchAdminCoupons() {
  return adminFetch<{ coupons: AdminCoupon[] }>('/coupons');
}

export function createAdminCoupon(payload: AdminCouponPayload) {
  return adminSend<{ coupon: AdminCoupon }>('POST', '/coupons', payload);
}

export function updateAdminCoupon(id: string, payload: Partial<AdminCouponPayload>) {
  return adminSend<{ coupon: AdminCoupon }>('PATCH', `/coupons/${id}`, payload);
}

export function activateAdminCoupon(id: string) {
  return adminSend<{ coupon: AdminCoupon }>('POST', `/coupons/${id}/activate`);
}

export function deactivateAdminCoupon(id: string) {
  return adminSend<{ coupon: AdminCoupon }>('POST', `/coupons/${id}/deactivate`);
}

export function deleteAdminCoupon(id: string) {
  return adminSend<void>('DELETE', `/coupons/${id}`);
}
