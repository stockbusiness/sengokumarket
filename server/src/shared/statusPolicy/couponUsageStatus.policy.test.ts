import { describe, expect, it } from 'vitest';
import { DomainError } from '../errors/domainError';
import { assertCouponUsageTransition } from './couponUsageStatus.policy';

describe('assertCouponUsageTransition', () => {
  it('reserved→usedは許可される', () => {
    expect(() => assertCouponUsageTransition('reserved', 'used')).not.toThrow();
  });

  it('used→cancelledは許可される(全額返金時のrestoreOnCancel)', () => {
    expect(() => assertCouponUsageTransition('used', 'cancelled')).not.toThrow();
  });

  it('cancelled→usedは不正遷移として拒否される', () => {
    expect(() => assertCouponUsageTransition('cancelled', 'used')).toThrowError(
      expect.objectContaining({ code: 'INVALID_COUPON_USAGE_STATUS_TRANSITION' } satisfies Partial<DomainError>),
    );
  });
});
