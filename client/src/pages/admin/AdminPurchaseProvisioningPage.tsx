import { useEffect, useState } from 'react';
import {
  fetchAdminPurchaseProvisioningJobs,
  retryAdminPurchaseProvisioningJob,
  skipAdminPurchaseProvisioningJob,
  type AdminPurchaseProvisioningJob,
} from '../../features/admin-purchase-provisioning/api';
import { PURCHASE_PROVISIONING_JOB_STATUSES as STATUSES } from '@sengoku/contracts';
import QueueEventTable from '../../components/QueueEventTable';
import EmptyState from '../../components/EmptyState';
import Pagination from '../../components/Pagination';

// 購入後代理店システム連携実装指示書 6.13章「管理画面」。order_linking_jobsの管理画面
// (AdminOrderLinkingJobsPage.tsx)と同じ設計(一覧・ステータス絞り込み・手動再送・skip)に、
// 注文番号・メール・common_user_idでの検索を追加する。
export default function AdminPurchaseProvisioningPage() {
  const [jobs, setJobs] = useState<AdminPurchaseProvisioningJob[]>([]);
  const [statusFilter, setStatusFilter] = useState('');
  const [searchInput, setSearchInput] = useState('');
  const [search, setSearch] = useState('');
  const [page, setPage] = useState(1);
  const [total, setTotal] = useState(0);
  const [pageSize, setPageSize] = useState(50);
  const [error, setError] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);

  function load() {
    fetchAdminPurchaseProvisioningJobs(page, statusFilter || undefined, search || undefined).then((d) => {
      setJobs(d.jobs);
      setTotal(d.total);
      setPageSize(d.pageSize);
    });
  }
  useEffect(load, [page, statusFilter, search]);

  function handleStatusFilterChange(value: string) {
    setStatusFilter(value);
    setPage(1);
  }

  function handleSearchSubmit(e: React.FormEvent) {
    e.preventDefault();
    setSearch(searchInput.trim());
    setPage(1);
  }

  async function retry(job: AdminPurchaseProvisioningJob) {
    setError(null);
    setMessage(null);
    try {
      await retryAdminPurchaseProvisioningJob(job.id);
      setMessage('再送対象にしました');
      load();
    } catch (e) {
      setError(e instanceof Error ? e.message : '再送の設定に失敗しました');
    }
  }

  async function skip(job: AdminPurchaseProvisioningJob) {
    setError(null);
    setMessage(null);
    try {
      await skipAdminPurchaseProvisioningJob(job.id);
      setMessage('このジョブを処理対象から外しました');
      load();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'skipの設定に失敗しました');
    }
  }

  return (
    <div>
      <h1>代理店ポータル連携ジョブ</h1>
      <p>
        購入後に代理店システムへログイン権限を発行する処理(purchase-provisioning)の一覧です。
        action列の「provision」はアカウント発行、「revoke」は全額返金時の取消を表します。
      </p>

      <form onSubmit={handleSearchSubmit}>
        <label>
          注文番号・メール・common_user_idで検索
          <input type="text" value={searchInput} onChange={(e) => setSearchInput(e.target.value)} />
        </label>
        <button type="submit" className="btn-secondary btn-small">
          検索
        </button>
      </form>

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
          <EmptyState message="該当するジョブがありません" />
        </div>
      ) : (
        <>
          <div className="admin-table-card">
            <QueueEventTable
              rows={jobs}
              idColumnHeader="action・対象注文"
              renderIdColumn={(j) => (
                <>
                  {j.action}
                  <br />
                  <span className="admin-muted">
                    {j.order?.orderNumber ?? j.orderId}
                    {j.order?.customerEmail && ` / ${j.order.customerEmail}`}
                  </span>
                </>
              )}
              onRetry={retry}
              extraActions={(j) =>
                (j.status === 'blocked' || j.status === 'pending') && (
                  <button type="button" className="btn-secondary btn-small" onClick={() => skip(j)}>
                    処理対象から外す
                  </button>
                )
              }
            />
          </div>
          <Pagination page={page} total={total} pageSize={pageSize} onPageChange={setPage} />
        </>
      )}
    </div>
  );
}
