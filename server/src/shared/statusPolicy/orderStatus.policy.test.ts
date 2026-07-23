import { describe, expect, it } from 'vitest';
import { DomainError } from '../errors/domainError';
import { assertOrderTransition } from './orderStatus.policy';

// DBに依存しないDomain Unit Test(指示書15.1「status transition」)。
describe('assertOrderTransition', () => {
  it('pending→paidは許可される', () => {
    expect(() => assertOrderTransition('pending', 'paid')).not.toThrow();
  });

  it('pending→cancelledは許可される', () => {
    expect(() => assertOrderTransition('pending', 'cancelled')).not.toThrow();
  });

  it('paid→refundedは許可される', () => {
    expect(() => assertOrderTransition('paid', 'refunded')).not.toThrow();
  });

  it('paid→cancelledは許可される(Stripe返金を伴わない管理画面での手動キャンセル)', () => {
    expect(() => assertOrderTransition('paid', 'cancelled')).not.toThrow();
  });

  it('同一状態への再設定は常に許可される(冪等)', () => {
    expect(() => assertOrderTransition('paid', 'paid')).not.toThrow();
  });

  it('paid→pendingは不正遷移として拒否される(指示書1.7の例)', () => {
    expect(() => assertOrderTransition('paid', 'pending')).toThrowError(
      expect.objectContaining({ code: 'INVALID_ORDER_STATUS_TRANSITION' } satisfies Partial<DomainError>),
    );
  });

  it('refunded→paidは不正遷移として拒否される(終端状態からの逆行)', () => {
    expect(() => assertOrderTransition('refunded', 'paid')).toThrowError(DomainError);
  });

  it('cancelled→paidは不正遷移として拒否される', () => {
    expect(() => assertOrderTransition('cancelled', 'paid')).toThrowError(DomainError);
  });
});
