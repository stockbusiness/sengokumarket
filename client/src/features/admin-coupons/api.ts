import { adminFetch, adminSend } from '../../shared/api/adminClient';

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

export interface CreateCouponRequest {
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

export type UpdateCouponRequest = Partial<CreateCouponRequest>;

export function fetchAdminCoupons() {
  return adminFetch<{ coupons: AdminCoupon[] }>('/coupons');
}

export function createAdminCoupon(payload: CreateCouponRequest) {
  return adminSend<{ coupon: AdminCoupon }>('POST', '/coupons', payload);
}

export function updateAdminCoupon(id: string, payload: UpdateCouponRequest) {
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
