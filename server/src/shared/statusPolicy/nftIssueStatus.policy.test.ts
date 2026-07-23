import { describe, expect, it } from 'vitest';
import { DomainError } from '../errors/domainError';
import { assertNftIssueTransition } from './nftIssueStatus.policy';

describe('assertNftIssueTransition', () => {
  it('wallet_required→ready_to_issueは許可される', () => {
    expect(() => assertNftIssueTransition('wallet_required', 'ready_to_issue')).not.toThrow();
  });

  it('ready_to_issue→issuedは許可される(管理画面からの手動記録)', () => {
    expect(() => assertNftIssueTransition('ready_to_issue', 'issued')).not.toThrow();
  });

  it('processing→ready_to_issueは許可される(発行失敗後の再試行)', () => {
    expect(() => assertNftIssueTransition('processing', 'ready_to_issue')).not.toThrow();
  });

  it('ready_to_issue→cancelledは許可される(返金・キャンセル)', () => {
    expect(() => assertNftIssueTransition('ready_to_issue', 'cancelled')).not.toThrow();
  });

  it('issued→wallet_requiredは不正遷移として拒否される(指示書1.7の例)', () => {
    expect(() => assertNftIssueTransition('issued', 'wallet_required')).toThrowError(
      expect.objectContaining({ code: 'INVALID_NFT_ISSUE_STATUS_TRANSITION' } satisfies Partial<DomainError>),
    );
  });

  it('cancelled→ready_to_issueは不正遷移として拒否される(終端状態からの復帰)', () => {
    expect(() => assertNftIssueTransition('cancelled', 'ready_to_issue')).toThrowError(DomainError);
  });

  it('同一状態への再設定は常に許可される(冪等)', () => {
    expect(() => assertNftIssueTransition('issued', 'issued')).not.toThrow();
  });
});
