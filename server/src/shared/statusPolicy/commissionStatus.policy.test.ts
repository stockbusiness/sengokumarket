import { describe, expect, it } from 'vitest';
import { DomainError } from '../errors/domainError';
import { assertCommissionTransition } from './commissionStatus.policy';

describe('assertCommissionTransition', () => {
  it('pending→approvedは許可される', () => {
    expect(() => assertCommissionTransition('pending', 'approved')).not.toThrow();
  });

  it('approved→paidは許可される', () => {
    expect(() => assertCommissionTransition('approved', 'paid')).not.toThrow();
  });

  it('pending→paidは不正遷移として拒否される(approvedを必ず経由させる)', () => {
    expect(() => assertCommissionTransition('pending', 'paid')).toThrowError(
      expect.objectContaining({ code: 'INVALID_COMMISSION_STATUS_TRANSITION' } satisfies Partial<DomainError>),
    );
  });

  it('paid→cancelledは不正遷移として拒否される(支払済み報酬は回収注記を残すのみ)', () => {
    expect(() => assertCommissionTransition('paid', 'cancelled')).toThrowError(DomainError);
  });

  it('cancelled→pendingは不正遷移として拒否される(終端状態からの逆行)', () => {
    expect(() => assertCommissionTransition('cancelled', 'pending')).toThrowError(DomainError);
  });

  it('同一状態への再設定は常に許可される(冪等)', () => {
    expect(() => assertCommissionTransition('approved', 'approved')).not.toThrow();
  });
});
