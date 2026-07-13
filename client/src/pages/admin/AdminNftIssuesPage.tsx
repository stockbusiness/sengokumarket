import { useEffect, useState } from 'react';
import {
  fetchAdminNftIssues,
  updateAdminNftIssue,
  retryAdminNftIssue,
  holdAdminNftIssue,
  type AdminNftIssue,
} from '../../lib/adminApi';
import StatusSelect from '../../components/StatusSelect';
import EmptyState from '../../components/EmptyState';

const STATUSES = ['wallet_required', 'ready_to_issue', 'processing', 'issued', 'failed', 'cancelled'];

export default function AdminNftIssuesPage() {
  const [nftIssues, setNftIssues] = useState<AdminNftIssue[]>([]);
  const [statusFilter, setStatusFilter] = useState('');
  const [drafts, setDrafts] = useState<Record<string, { tokenId: string; transactionHash: string }>>({});
  const [error, setError] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);

  function load() {
    fetchAdminNftIssues(statusFilter || undefined).then((d) => setNftIssues(d.nftIssues));
  }
  useEffect(load, [statusFilter]);

  function draftFor(issue: AdminNftIssue) {
    return drafts[issue.id] ?? { tokenId: issue.tokenId ?? '', transactionHash: issue.transactionHash ?? '' };
  }

  async function markIssued(issue: AdminNftIssue) {
    const draft = draftFor(issue);
    setError(null);
    try {
      await updateAdminNftIssue(issue.id, { status: 'issued', tokenId: draft.tokenId, transactionHash: draft.transactionHash });
      load();
    } catch (e) {
      setError(e instanceof Error ? e.message : '更新に失敗しました');
    }
  }

  async function changeStatus(issue: AdminNftIssue, status: string) {
    await updateAdminNftIssue(issue.id, { status });
    load();
  }

  // 仕様書外の拡張(NFT自動発行): 外部Mint APIへの自動送信を今すぐ再試行/一時的に止める。
  async function retry(issue: AdminNftIssue) {
    setError(null);
    setMessage(null);
    try {
      await retryAdminNftIssue(issue.id);
      setMessage(`${issue.customerName}様の発行を再試行対象にしました(次回の自動処理で再送信されます)`);
      load();
    } catch (e) {
      setError(e instanceof Error ? e.message : '再試行の設定に失敗しました');
    }
  }

  async function hold(issue: AdminNftIssue) {
    setError(null);
    setMessage(null);
    try {
      await holdAdminNftIssue(issue.id);
      setMessage(`${issue.customerName}様の発行を保留にしました(自動処理の対象から外れます)`);
      load();
    } catch (e) {
      setError(e instanceof Error ? e.message : '保留の設定に失敗しました');
    }
  }

  return (
    <div>
      <h1>NFT発行管理</h1>

      <label>
        ステータスで絞り込み
        <select value={statusFilter} onChange={(e) => setStatusFilter(e.target.value)}>
          <option value="">すべて</option>
          {STATUSES.map((s) => (
            <option key={s} value={s}>
              {s}
            </option>
          ))}
        </select>
      </label>

      {error && <p className="checkout-error">{error}</p>}
      {message && <p>{message}</p>}

      {nftIssues.length === 0 ? (
        <div className="admin-table-card">
          <EmptyState message="該当するNFT発行データがありません" />
        </div>
      ) : (
        <div className="admin-table-card">
          <table>
            <thead>
              <tr>
                <th>購入者</th>
                <th>商品</th>
                <th>ウォレット</th>
                <th>ステータス</th>
                <th>token ID</th>
                <th>transaction hash</th>
                <th>自動発行状況(仕様書外の拡張)</th>
                <th>操作</th>
              </tr>
            </thead>
            <tbody>
              {nftIssues.map((issue) => (
                <tr key={issue.id}>
                  <td>{issue.customerName}</td>
                  <td>
                    {issue.productName} {issue.variantName}
                  </td>
                  <td>{issue.walletAddress ?? '-'}</td>
                  <td>
                    <StatusSelect value={issue.status} options={STATUSES} onChange={(v) => changeStatus(issue, v)} />
                  </td>
                  <td>
                    <input
                      type="text"
                      className="admin-inline-input"
                      value={draftFor(issue).tokenId}
                      onChange={(e) => setDrafts((d) => ({ ...d, [issue.id]: { ...draftFor(issue), tokenId: e.target.value } }))}
                    />
                  </td>
                  <td>
                    <input
                      type="text"
                      className="admin-inline-input"
                      style={{ width: '14em' }}
                      value={draftFor(issue).transactionHash}
                      onChange={(e) =>
                        setDrafts((d) => ({ ...d, [issue.id]: { ...draftFor(issue), transactionHash: e.target.value } }))
                      }
                    />
                  </td>
                  <td>
                    {issue.attemptCount > 0 && <p>試行回数: {issue.attemptCount}</p>}
                    {issue.submittedAt && <p>送信日時: {new Date(issue.submittedAt).toLocaleString('ja-JP')}</p>}
                    {issue.lastError && <p className="checkout-error">最終エラー: {issue.lastError}</p>}
                    {issue.nextAttemptAt && new Date(issue.nextAttemptAt).getTime() > Date.now() && (
                      <p>次回再試行: {new Date(issue.nextAttemptAt).toLocaleString('ja-JP')}</p>
                    )}
                  </td>
                  <td>
                    <button type="button" className="btn-primary btn-small" onClick={() => markIssued(issue)}>
                      発行済みにする
                    </button>
                    {(issue.status === 'failed' || issue.status === 'ready_to_issue') && (
                      <>
                        <button type="button" className="btn-secondary btn-small" onClick={() => retry(issue)}>
                          今すぐ再試行
                        </button>
                        <button type="button" className="btn-secondary btn-small" onClick={() => hold(issue)}>
                          保留
                        </button>
                      </>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
