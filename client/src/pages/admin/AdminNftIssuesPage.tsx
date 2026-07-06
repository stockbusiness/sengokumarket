import { useEffect, useState } from 'react';
import { fetchAdminNftIssues, updateAdminNftIssue, type AdminNftIssue } from '../../lib/adminApi';

const STATUSES = ['wallet_required', 'ready_to_issue', 'issued', 'failed', 'cancelled'];

export default function AdminNftIssuesPage() {
  const [nftIssues, setNftIssues] = useState<AdminNftIssue[]>([]);
  const [statusFilter, setStatusFilter] = useState('');
  const [drafts, setDrafts] = useState<Record<string, { tokenId: string; transactionHash: string }>>({});
  const [error, setError] = useState<string | null>(null);

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

      <table>
        <thead>
          <tr>
            <th>購入者</th>
            <th>商品</th>
            <th>ウォレット</th>
            <th>ステータス</th>
            <th>token ID</th>
            <th>transaction hash</th>
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
                <select value={issue.status} onChange={(e) => changeStatus(issue, e.target.value)}>
                  {STATUSES.map((s) => (
                    <option key={s} value={s}>
                      {s}
                    </option>
                  ))}
                </select>
              </td>
              <td>
                <input
                  type="text"
                  value={draftFor(issue).tokenId}
                  onChange={(e) => setDrafts((d) => ({ ...d, [issue.id]: { ...draftFor(issue), tokenId: e.target.value } }))}
                />
              </td>
              <td>
                <input
                  type="text"
                  size={20}
                  value={draftFor(issue).transactionHash}
                  onChange={(e) =>
                    setDrafts((d) => ({ ...d, [issue.id]: { ...draftFor(issue), transactionHash: e.target.value } }))
                  }
                />
              </td>
              <td>
                <button type="button" onClick={() => markIssued(issue)}>
                  発行済みにする
                </button>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
