import { useEffect, useState } from 'react';
import { fetchAdminAuditLogs, type AdminAuditLogEntry } from '../../lib/adminApi';
import EmptyState from '../../components/EmptyState';

function formatBody(body: unknown): string {
  if (body === null || body === undefined || (typeof body === 'object' && Object.keys(body).length === 0)) return '-';
  const json = JSON.stringify(body);
  return json.length > 160 ? `${json.slice(0, 160)}...` : json;
}

export default function AdminAuditLogsPage() {
  const [logs, setLogs] = useState<AdminAuditLogEntry[]>([]);
  const [page, setPage] = useState(1);
  const [total, setTotal] = useState(0);
  const [pageSize, setPageSize] = useState(50);

  useEffect(() => {
    fetchAdminAuditLogs(page).then((d) => {
      setLogs(d.logs);
      setTotal(d.total);
      setPageSize(d.pageSize);
    });
  }, [page]);

  const totalPages = Math.max(Math.ceil(total / pageSize), 1);

  return (
    <div>
      <h1>監査ログ</h1>
      <p>管理者・代理店ポータルによる登録・変更・削除操作の履歴です(閲覧のみの操作は含まれません)。</p>

      {logs.length === 0 ? (
        <div className="admin-table-card">
          <EmptyState message="操作履歴がありません" />
        </div>
      ) : (
        <>
          <div className="admin-table-card">
            <table>
              <thead>
                <tr>
                  <th>日時</th>
                  <th>操作者</th>
                  <th>操作</th>
                  <th>内容</th>
                  <th>結果</th>
                </tr>
              </thead>
              <tbody>
                {logs.map((log) => (
                  <tr key={log.id}>
                    <td>{new Date(log.createdAt).toLocaleString('ja-JP')}</td>
                    <td>
                      {log.actorEmail}
                      <br />
                      {log.actorRole}
                    </td>
                    <td>
                      {log.method} {log.path}
                    </td>
                    <td className="admin-audit-body">{formatBody(log.requestBody)}</td>
                    <td>{log.statusCode}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <div className="admin-pagination">
            <button type="button" className="btn-secondary btn-small" disabled={page <= 1} onClick={() => setPage((p) => p - 1)}>
              前へ
            </button>
            <span>
              {page} / {totalPages}ページ({total}件)
            </span>
            <button
              type="button"
              className="btn-secondary btn-small"
              disabled={page >= totalPages}
              onClick={() => setPage((p) => p + 1)}
            >
              次へ
            </button>
          </div>
        </>
      )}
    </div>
  );
}
