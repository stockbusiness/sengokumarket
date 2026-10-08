import { useEffect, useState } from 'react';
import { fetchAdminAgencySsoFailures, type AdminAgencySsoFailure } from '../../features/admin-agency-sso-failures/api';
import EmptyState from '../../components/EmptyState';
import Pagination from '../../components/Pagination';

function formatDateTime(value: string): string {
  return new Date(value).toLocaleString('ja-JP');
}

// 仕様書外の拡張(2026-10・緊急障害対応): 代理店SSOログイン失敗の一覧。Vercelの実行ログを
// 開けない状況でも、失敗の原因切り分けに必要な情報(クレームの有無・subの値等)を
// 管理画面から直接確認できるようにする。
export default function AdminAgencySsoFailuresPage() {
  const [failures, setFailures] = useState<AdminAgencySsoFailure[]>([]);
  const [page, setPage] = useState(1);
  const [total, setTotal] = useState(0);
  const [pageSize, setPageSize] = useState(50);

  function load() {
    fetchAdminAgencySsoFailures(page).then((d) => {
      setFailures(d.failures);
      setTotal(d.total);
      setPageSize(d.pageSize);
    });
  }
  useEffect(load, [page]);

  return (
    <div>
      <h1>代理店SSOログイン失敗ログ</h1>
      <p>代理店システムからの自動ログイン(SSO)が失敗した際の記録です。新しいもの順に表示しています。</p>
      {total === 0 ? (
        <div className="admin-table-card">
          <EmptyState message="失敗の記録はありません" />
        </div>
      ) : (
        <>
          <div className="admin-table-card">
            <table>
              <thead>
                <tr>
                  <th>発生日時</th>
                  <th>エラーコード</th>
                  <th>sub</th>
                  <th>agency_nameクレーム</th>
                  <th>actor_emailクレーム</th>
                  <th>contact_emailクレーム</th>
                </tr>
              </thead>
              <tbody>
                {failures.map((f) => (
                  <tr key={f.id}>
                    <td>{formatDateTime(f.createdAt)}</td>
                    <td>{f.errorCode}</td>
                    <td>{f.detail?.sub ?? '-'}</td>
                    <td>{f.detail?.agencyNameClaim ?? '-'}</td>
                    <td>{f.detail?.hasActorEmailClaim ? 'あり' : 'なし'}</td>
                    <td>{f.detail?.hasContactEmailClaim ? 'あり' : 'なし'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <Pagination page={page} total={total} pageSize={pageSize} onPageChange={setPage} />
        </>
      )}
    </div>
  );
}
