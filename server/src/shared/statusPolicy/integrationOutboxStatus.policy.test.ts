import { describe, expect, it } from 'vitest';
import { DomainError } from '../errors/domainError';
import { assertIntegrationOutboxTransition } from './integrationOutboxStatus.policy';

describe('assertIntegrationOutboxTransition', () => {
  it('pending→processingは許可される', () => {
    expect(() => assertIntegrationOutboxTransition('pending', 'processing')).not.toThrow();
  });

  it('processing→pendingは許可される(staleなprocessing行の復帰・バックオフ再試行)', () => {
    expect(() => assertIntegrationOutboxTransition('processing', 'pending')).not.toThrow();
  });

  it('succeeded→processingは不正遷移として拒否される', () => {
    expect(() => assertIntegrationOutboxTransition('succeeded', 'processing')).toThrowError(
      expect.objectContaining({ code: 'INVALID_INTEGRATION_OUTBOX_STATUS_TRANSITION' } satisfies Partial<DomainError>),
    );
  });
});
