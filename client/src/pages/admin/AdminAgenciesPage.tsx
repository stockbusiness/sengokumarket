import { useEffect, useState } from 'react';
import { fetchAdminAgenciesDetail, syncAgenciesFromExternalSystem, type AdminAgencyDetail } from '../../lib/adminApi';
import StatusBadge from '../../components/StatusBadge';
import EmptyState from '../../components/EmptyState';

export default function AdminAgenciesPage() {
  const [agencies, setAgencies] = useState<AdminAgencyDetail[]>([]);
  const [syncing, setSyncing] = useState(false);
  const [syncMessage, setSyncMessage] = useState<string | null>(null);
  const [syncError, setSyncError] = useState<string | null>(null);

  function load() {
    fetchAdminAgenciesDetail().then((d) => setAgencies(d.agencies));
  }
  useEffect(load, []);

  async function handleSync() {
    setSyncing(true);
    setSyncMessage(null);
    setSyncError(null);
    try {
      const result = await syncAgenciesFromExternalSystem();
      setSyncMessage(`同期しました(代理店${result.agenciesSynced}件・申請承認${result.applicationsApproved}件)`);
      load();
    } catch (e) {
      setSyncError(e instanceof Error ? e.message : '同期に失敗しました');
    } finally {
      setSyncing(false);
    }
  }

  return (
    <div>
      <h1>代理店一覧</h1>
      <p>外部の代理店システム(sengoku-ai.com)と連携して登録された代理店(親子ツリー・ログイン設定)を確認できます。</p>

      <button type="button" className="btn-secondary" onClick={handleSync} disabled={syncing}>
        {syncing ? '同期中...' : '外部代理店システムと今すぐ同期する'}
      </button>
      {syncMessage && <p>{syncMessage}</p>}
      {syncError && <p className="checkout-error">{syncError}</p>}

      {agencies.length === 0 ? (
        <div className="admin-table-card">
          <EmptyState message="まだ代理店が登録されていません" />
        </div>
      ) : (
        <div className="admin-table-card">
          <table>
            <thead>
              <tr>
                <th>名前</th>
                <th>コード</th>
                <th>外部ID</th>
                <th>親代理店</th>
                <th>既定報酬率</th>
                <th>ステータス</th>
                <th>ログイン用メール</th>
              </tr>
            </thead>
            <tbody>
              {agencies.map((a) => (
                <tr key={a.id}>
                  <td>{a.name}</td>
                  <td>{a.code}</td>
                  <td>{a.externalId ?? '-'}</td>
                  <td>{a.parentAgencyName ?? '-'}</td>
                  <td>{a.defaultCommissionRate}%</td>
                  <td>
                    <StatusBadge status={a.status} />
                  </td>
                  <td>{a.loginEmail ?? '-'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
