import { useEffect, useState } from 'react';
import {
  fetchAdminOrderLinkingJobs,
  retryAdminOrderLinkingJob,
  skipAdminOrderLinkingJob,
  type AdminOrderLinkingJob,
} from '../../features/admin-order-linking-jobs/api';
import { ORDER_LINKING_JOB_STATUSES as STATUSES } from '@sengoku/contracts';
import QueueEventTable from '../../components/QueueEventTable';
import EmptyState from '../../components/EmptyState';
import Pagination from '../../components/Pagination';

// 本番安定化指示書Stage11(14.1「Order Linking Jobs」・「External Identity conflicts」画面)。
// conflictOnly=trueの場合は共通ID競合(common_user_id_conflict)で保留中のジョブだけに絞った
// 専用画面として使う(PR-10で追加されたExternalIdentityの整合性トラブルの確認・再送用)。
// lazyWithReloadはdefault exportがpropsを取らないことを要求するため、実体はnamed export
// (OrderLinkingJobsView)にし、default exportはprops無しの薄いラッパーにする
// (AdminExternalIdentityConflictsPage.tsxがOrderLinkingJobsViewを直接importして再利用する)。
export function OrderLinkingJobsView({ conflictOnly = false }: { conflictOnly?: boolean }) {
  const [jobs, setJobs] = useState<AdminOrderLinkingJob[]>([]);
  const [statusFilter, setStatusFilter] = useState('');
  const [page, setPage] = useState(1);
  const [total, setTotal] = useState(0);
  const [pageSize, setPageSize] = useState(50);
  const [error, setError] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);

  function load() {
    fetchAdminOrderLinkingJobs(page, statusFilter || undefined, conflictOnly ? 'common_user_id_conflict' : undefined).then((d) => {
      setJobs(d.jobs);
      setTotal(d.total);
      setPageSize(d.pageSize);
    });
  }
  useEffect(load, [page, statusFilter]);

  function handleStatusFilterChange(value: string) {
    setStatusFilter(value);
    setPage(1);
  }

  async function retry(job: AdminOrderLinkingJob) {
    setError(null);
    setMessage(null);
    try {
      await retryAdminOrderLinkingJob(job.id);
      setMessage('再送対象にしました');
      load();
    } catch (e) {
      setError(e instanceof Error ? e.message : '再送の設定に失敗しました');
    }
  }

  async function skip(job: AdminOrderLinkingJob) {
    setError(null);
    setMessage(null);
    try {
      await skipAdminOrderLinkingJob(job.id);
      setMessage('このジョブを処理対象から外しました');
      load();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'skipの設定に失敗しました');
    }
  }

  return (
    <div>
      <h1>{conflictOnly ? '共通ID競合(External Identity conflicts)' : 'Order Linking Jobs(共通ID・紹介連携)'}</h1>
      {conflictOnly ? (
        <p>
          外部の共通顧客HUBから返ってきたcommon_user_idが、既にこのユーザーへ紐付いている別のIDと食い違っているために保留中の
          ジョブです。原因を確認したうえで、必要であれば再送してください。
        </p>
      ) : (
        <p>会員登録・紹介コード確定時のcommon_user_id解決・紹介連携ジョブの一覧です。</p>
      )}

      {!conflictOnly && (
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
      )}

      {error && <p className="checkout-error">{error}</p>}
      {message && <p>{message}</p>}

      {total === 0 ? (
        <div className="admin-table-card">
          <EmptyState message={conflictOnly ? '共通ID競合で保留中のジョブはありません' : '該当するジョブがありません'} />
        </div>
      ) : (
        <>
          <div className="admin-table-card">
            <QueueEventTable
              rows={jobs}
              idColumnHeader="種別・対象"
              renderIdColumn={(j) => (
                <>
                  {j.jobType}
                  <br />
                  <span className="admin-muted">
                    {j.userId && `user: ${j.userId}`}
                    {j.orderId && ` order: ${j.orderId}`}
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

export default function AdminOrderLinkingJobsPage() {
  return <OrderLinkingJobsView />;
}
