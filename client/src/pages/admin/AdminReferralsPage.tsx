import { useEffect, useState } from 'react';
import {
  buildReferralExportCsvUrl,
  fetchAdminCommissions,
  fetchAdminReferralsSummary,
  updateAdminCommission,
  type AdminCommission,
  type AdminReferralSummary,
} from '../../lib/adminApi';
import StatusSelect from '../../components/StatusSelect';
import EmptyState from '../../components/EmptyState';

const COMMISSION_STATUSES = ['pending', 'approved', 'paid', 'cancelled'];

export default function AdminReferralsPage() {
  const [summary, setSummary] = useState<AdminReferralSummary | null>(null);
  const [commissions, setCommissions] = useState<AdminCommission[]>([]);
  const [statusFilter, setStatusFilter] = useState('');
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const [markApproved, setMarkApproved] = useState(false);

  function loadCommissions() {
    fetchAdminCommissions(statusFilter || undefined).then((d) => setCommissions(d.commissions));
  }

  useEffect(() => {
    fetchAdminReferralsSummary().then(setSummary);
  }, []);
  useEffect(loadCommissions, [statusFilter]);

  async function changeStatus(commission: AdminCommission, status: string) {
    await updateAdminCommission(commission.id, { status });
    loadCommissions();
  }

  function handleExport() {
    if (!from || !to) return;
    const url = buildReferralExportCsvUrl({ from, to, status: 'pending,approved', markApproved });
    window.location.href = url;
  }

  return (
    <div>
      <h1>代理店・紹介成果管理</h1>

      {summary && (
        <>
          <h2>代理店別売上</h2>
          {summary.byAgency.length === 0 ? (
            <div className="admin-table-card">
              <EmptyState message="まだ代理店経由の実績がありません" />
            </div>
          ) : (
            <div className="admin-table-card">
              <table>
                <thead>
                  <tr>
                    <th>代理店</th>
                    <th>注文件数</th>
                    <th>決済完了件数</th>
                    <th>売上</th>
                    <th>報酬額</th>
                  </tr>
                </thead>
                <tbody>
                  {summary.byAgency.map((a) => (
                    <tr key={a.agencyId}>
                      <td>{a.agencyName}</td>
                      <td>{a.orderCount}</td>
                      <td>{a.paidCount}</td>
                      <td>{a.salesAmount.toLocaleString()}円</td>
                      <td>{a.commissionAmount.toLocaleString()}円</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}

          <h2>インフルエンサー別売上</h2>
          {summary.byInfluencer.length === 0 ? (
            <div className="admin-table-card">
              <EmptyState message="まだインフルエンサー経由の実績がありません" />
            </div>
          ) : (
            <div className="admin-table-card">
              <table>
                <thead>
                  <tr>
                    <th>インフルエンサー</th>
                    <th>所属代理店</th>
                    <th>注文件数</th>
                    <th>決済完了件数</th>
                    <th>売上</th>
                    <th>報酬額</th>
                  </tr>
                </thead>
                <tbody>
                  {summary.byInfluencer.map((i) => (
                    <tr key={i.influencerId}>
                      <td>{i.influencerName}</td>
                      <td>{i.agencyName ?? '-'}</td>
                      <td>{i.orderCount}</td>
                      <td>{i.paidCount}</td>
                      <td>{i.salesAmount.toLocaleString()}円</td>
                      <td>{i.commissionAmount.toLocaleString()}円</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </>
      )}

      <h2>報酬CSV出力</h2>
      <div className="referrals-export-form">
        <label>
          決済日From
          <input type="date" value={from} onChange={(e) => setFrom(e.target.value)} />
        </label>
        <label>
          決済日To
          <input type="date" value={to} onChange={(e) => setTo(e.target.value)} />
        </label>
        <label>
          <input type="checkbox" checked={markApproved} onChange={(e) => setMarkApproved(e.target.checked)} />
          出力対象のpendingをapprovedに一括変更する
        </label>
        <button type="button" className="btn-primary btn-small" onClick={handleExport} disabled={!from || !to}>
          CSV出力
        </button>
      </div>

      <h2>報酬一覧</h2>
      <label>
        ステータスで絞り込み
        <select value={statusFilter} onChange={(e) => setStatusFilter(e.target.value)}>
          <option value="">すべて</option>
          {COMMISSION_STATUSES.map((s) => (
            <option key={s} value={s}>
              {s}
            </option>
          ))}
        </select>
      </label>
      {commissions.length === 0 ? (
        <div className="admin-table-card">
          <EmptyState message="該当する報酬データがありません" />
        </div>
      ) : (
        <div className="admin-table-card">
          <table>
            <thead>
              <tr>
                <th>注文番号</th>
                <th>購入者</th>
                <th>代理店/インフルエンサー</th>
                <th>報酬率</th>
                <th>報酬額</th>
                <th>ステータス</th>
              </tr>
            </thead>
            <tbody>
              {commissions.map((c) => (
                <tr key={c.id}>
                  <td>{c.orderNumber}</td>
                  <td>{c.customerName}</td>
                  <td>
                    {c.agencyName ?? '-'} / {c.influencerName ?? '-'}
                  </td>
                  <td>{c.commissionRate}%</td>
                  <td>{c.commissionAmount.toLocaleString()}円</td>
                  <td>
                    <StatusSelect value={c.status} options={COMMISSION_STATUSES} onChange={(v) => changeStatus(c, v)} />
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
