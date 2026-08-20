import { useEffect, useState } from 'react';
import {
  fetchAdminNftIssues,
  updateAdminNftIssue,
  retryAdminNftIssue,
  holdAdminNftIssue,
  mintAdminNftIssue,
  type AdminNftIssue,
} from '../../lib/adminApi';
import StatusSelect from '../../components/StatusSelect';
import EmptyState from '../../components/EmptyState';
import Pagination from '../../components/Pagination';
import { NFT_ISSUE_STATUSES as STATUSES, NFT_ISSUE_STATUS_TRANSITIONS, type NftIssueStatus } from '@sengoku/contracts';

export default function AdminNftIssuesPage() {
  const [nftIssues, setNftIssues] = useState<AdminNftIssue[]>([]);
  const [statusFilter, setStatusFilter] = useState('');
  const [drafts, setDrafts] = useState<Record<string, { tokenId: string; transactionHash: string }>>({});
  const [serialDrafts, setSerialDrafts] = useState<Record<string, string>>({});
  const [minting, setMinting] = useState<Record<string, boolean>>({});
  const [error, setError] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [page, setPage] = useState(1);
  const [total, setTotal] = useState(0);
  const [pageSize, setPageSize] = useState(50);

  function load() {
    fetchAdminNftIssues(page, statusFilter || undefined).then((d) => {
      setNftIssues(d.nftIssues);
      setTotal(d.total);
      setPageSize(d.pageSize);
    });
  }
  useEffect(load, [page, statusFilter]);

  function handleStatusFilterChange(value: string) {
    setStatusFilter(value);
    setPage(1);
  }

  function draftFor(issue: AdminNftIssue) {
    return drafts[issue.id] ?? { tokenId: issue.tokenId ?? '', transactionHash: issue.transactionHash ?? '' };
  }

  function serialDraftFor(issue: AdminNftIssue) {
    return serialDrafts[issue.id] ?? String(issue.suggestedSerialNumber ?? issue.serialNumber ?? '');
  }

  // 仕様書外の拡張(運営手動Mint): シリアル番号を運営が確認してから、この操作でのみ外部Mint APIへ送信する
  // (cronによる自動送信は廃止。決済手段がカード・銀行振込の2経路あることと、シリアル番号を目視確認
  // してから刻みたいという運営の要望による)。
  async function mint(issue: AdminNftIssue) {
    const raw = serialDraftFor(issue);
    const serialNumber = Number(raw);
    if (!Number.isInteger(serialNumber) || serialNumber <= 0) {
      setError('シリアル番号は正の整数で入力してください');
      return;
    }
    setError(null);
    setMessage(null);
    setMinting((m) => ({ ...m, [issue.id]: true }));
    try {
      const { nftIssue } = await mintAdminNftIssue(issue.id, serialNumber);
      if (nftIssue.status === 'issued') {
        setMessage(`${issue.customerName}様(シリアル番号${serialNumber})の発行が完了しました`);
      } else {
        setMessage(`${issue.customerName}様への送信を行いました(現在のステータス: ${nftIssue.status}。詳細はエラー内容欄を確認してください)`);
      }
      load();
    } catch (e) {
      setError(e instanceof Error ? e.message : '発行に失敗しました');
    } finally {
      setMinting((m) => ({ ...m, [issue.id]: false }));
    }
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

  async function changeStatus(issue: AdminNftIssue, status: NftIssueStatus) {
    setError(null);
    try {
      await updateAdminNftIssue(issue.id, { status });
      load();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'NFT発行ステータスの更新に失敗しました');
    }
  }

  // 仕様書外の拡張(運営手動Mint): 失敗・バックオフ待ちの行を、再度「発行する」操作が行える状態に戻す。
  async function retry(issue: AdminNftIssue) {
    setError(null);
    setMessage(null);
    try {
      await retryAdminNftIssue(issue.id);
      setMessage(`${issue.customerName}様の発行を再試行可能な状態に戻しました(改めて「発行する」を押してください)`);
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
      setMessage(`${issue.customerName}様の発行を保留にしました(保留を解除するまで「発行する」操作ができなくなります)`);
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
        <select value={statusFilter} onChange={(e) => handleStatusFilterChange(e.target.value)}>
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

      {total === 0 ? (
        <div className="admin-table-card">
          <EmptyState message="該当するNFT発行データがありません" />
        </div>
      ) : (
        <>
        {nftIssues.length > 0 && (
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
                <th>シリアル番号(仕様書外の拡張)</th>
                <th>発行状況(仕様書外の拡張)</th>
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
                    <StatusSelect
                      value={issue.status as NftIssueStatus}
                      transitions={NFT_ISSUE_STATUS_TRANSITIONS}
                      onChange={(v) => changeStatus(issue, v)}
                    />
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
                    {issue.status === 'ready_to_issue' ? (
                      <input
                        type="number"
                        min={1}
                        className="admin-inline-input"
                        style={{ width: '6em' }}
                        value={serialDraftFor(issue)}
                        onChange={(e) => setSerialDrafts((d) => ({ ...d, [issue.id]: e.target.value }))}
                      />
                    ) : (
                      (issue.serialNumber ?? '-')
                    )}
                  </td>
                  <td>
                    {issue.attemptCount > 0 && <p>試行回数: {issue.attemptCount}</p>}
                    {issue.submittedAt && <p>送信日時: {new Date(issue.submittedAt).toLocaleString('ja-JP')}</p>}
                    {issue.lastError && <p className="checkout-error">最終エラー: {issue.lastError}</p>}
                    {issue.nextAttemptAt && new Date(issue.nextAttemptAt).getTime() > Date.now() && (
                      <p>保留・待機中(解除するまで発行不可): {new Date(issue.nextAttemptAt).toLocaleString('ja-JP')}まで</p>
                    )}
                  </td>
                  <td>
                    {issue.status === 'ready_to_issue' && (!issue.nextAttemptAt || new Date(issue.nextAttemptAt).getTime() <= Date.now()) && (
                      <button
                        type="button"
                        className="btn-primary btn-small"
                        disabled={minting[issue.id]}
                        onClick={() => mint(issue)}
                      >
                        発行する
                      </button>
                    )}
                    <button type="button" className="btn-secondary btn-small" onClick={() => markIssued(issue)}>
                      発行済みにする(手動修正)
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
        <Pagination page={page} total={total} pageSize={pageSize} onPageChange={setPage} />
        </>
      )}
    </div>
  );
}
