import { useEffect, useState } from 'react';
import { fetchAdminAgenciesDetail, type AdminAgencyDetail } from '../../lib/adminApi';

export default function AdminAgenciesPage() {
  const [agencies, setAgencies] = useState<AdminAgencyDetail[]>([]);

  useEffect(() => {
    fetchAdminAgenciesDetail().then((d) => setAgencies(d.agencies));
  }, []);

  return (
    <div>
      <h1>代理店一覧</h1>
      <p>外部の代理店システムと連携して登録された代理店(親子ツリー・ログイン設定)を確認できます。</p>
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
              <td>{a.status}</td>
              <td>{a.loginEmail ?? '-'}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
