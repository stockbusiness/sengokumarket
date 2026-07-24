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

  // 残課題指示書Stage6: 必須ID未解決による送信保留(blocked)の遷移。
  it('processing→blockedは許可される(必須ID未解決による送信保留)', () => {
    expect(() => assertIntegrationOutboxTransition('processing', 'blocked')).not.toThrow();
  });

  it('blocked→processingは許可される(ID解決後の自動再開)', () => {
    expect(() => assertIntegrationOutboxTransition('blocked', 'processing')).not.toThrow();
  });

  it('blocked→succeededは不正遷移として拒否される(必ずprocessingを経由する)', () => {
    expect(() => assertIntegrationOutboxTransition('blocked', 'succeeded')).toThrowError(
      expect.objectContaining({ code: 'INVALID_INTEGRATION_OUTBOX_STATUS_TRANSITION' } satisfies Partial<DomainError>),
    );
  });
});
