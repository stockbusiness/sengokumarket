import { describe, expect, it } from 'vitest';
import { DomainError } from '../errors/domainError';
import { assertStripeEventTransition } from './stripeEventStatus.policy';

describe('assertStripeEventTransition', () => {
  it('processing→succeededは許可される', () => {
    expect(() => assertStripeEventTransition('processing', 'succeeded')).not.toThrow();
  });

  it('failed_retryable→processingは許可される(再試行)', () => {
    expect(() => assertStripeEventTransition('failed_retryable', 'processing')).not.toThrow();
  });

  it('succeeded→processingは不正遷移として拒否される(終端状態からの逆行)', () => {
    expect(() => assertStripeEventTransition('succeeded', 'processing')).toThrowError(
      expect.objectContaining({ code: 'INVALID_STRIPE_EVENT_STATUS_TRANSITION' } satisfies Partial<DomainError>),
    );
  });
});
