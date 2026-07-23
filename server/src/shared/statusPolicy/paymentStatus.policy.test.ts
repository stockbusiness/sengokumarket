import { describe, expect, it } from 'vitest';
import { DomainError } from '../errors/domainError';
import { assertPaymentTransition } from './paymentStatus.policy';

describe('assertPaymentTransition', () => {
  it('pending→paidは許可される', () => {
    expect(() => assertPaymentTransition('pending', 'paid')).not.toThrow();
  });

  it('paid→refundedは許可される', () => {
    expect(() => assertPaymentTransition('paid', 'refunded')).not.toThrow();
  });

  it('refunded→paidは不正遷移として拒否される', () => {
    expect(() => assertPaymentTransition('refunded', 'paid')).toThrowError(
      expect.objectContaining({ code: 'INVALID_PAYMENT_STATUS_TRANSITION' } satisfies Partial<DomainError>),
    );
  });

  it('paid→pendingは不正遷移として拒否される', () => {
    expect(() => assertPaymentTransition('paid', 'pending')).toThrowError(DomainError);
  });
});
