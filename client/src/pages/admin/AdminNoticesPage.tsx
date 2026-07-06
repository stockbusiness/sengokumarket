import { useEffect, useState } from 'react';
import {
  createAdminNotice,
  deleteAdminNotice,
  fetchAdminNotices,
  updateAdminNotice,
  type AdminNotice,
} from '../../lib/adminApi';
import StatusBadge from '../../components/StatusBadge';
import EmptyState from '../../components/EmptyState';

export default function AdminNoticesPage() {
  const [notices, setNotices] = useState<AdminNotice[]>([]);
  const [title, setTitle] = useState('');
  const [body, setBody] = useState('');

  function load() {
    fetchAdminNotices().then((d) => setNotices(d.notices));
  }
  useEffect(load, []);

  async function handleCreate(e: React.FormEvent) {
    e.preventDefault();
    await createAdminNotice({ title, body });
    setTitle('');
    setBody('');
    load();
  }

  async function togglePublish(notice: AdminNotice) {
    await updateAdminNotice(notice.id, { status: notice.status === 'published' ? 'draft' : 'published' });
    load();
  }

  async function remove(notice: AdminNotice) {
    await deleteAdminNotice(notice.id);
    load();
  }

  return (
    <div>
      <h1>お知らせ管理</h1>

      <form onSubmit={handleCreate} className="admin-form-card">
        <label>
          タイトル
          <input type="text" value={title} onChange={(e) => setTitle(e.target.value)} required />
        </label>
        <label>
          本文
          <textarea value={body} onChange={(e) => setBody(e.target.value)} required />
        </label>
        <button type="submit" className="btn-primary">
          新規作成
        </button>
      </form>

      {notices.length === 0 ? (
        <div className="admin-table-card">
          <EmptyState message="まだお知らせがありません" />
        </div>
      ) : (
        <div className="admin-table-card">
          <table>
            <thead>
              <tr>
                <th>タイトル</th>
                <th>ステータス</th>
                <th>公開日時</th>
                <th>操作</th>
              </tr>
            </thead>
            <tbody>
              {notices.map((n) => (
                <tr key={n.id}>
                  <td>{n.title}</td>
                  <td>
                    <StatusBadge status={n.status} />
                  </td>
                  <td>{n.publishedAt ? new Date(n.publishedAt).toLocaleString('ja-JP') : '-'}</td>
                  <td>
                    <button type="button" className="btn-secondary btn-small" onClick={() => togglePublish(n)}>
                      {n.status === 'published' ? '非公開にする' : '公開する'}
                    </button>{' '}
                    <button type="button" className="btn-secondary btn-small" onClick={() => remove(n)}>
                      削除
                    </button>
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
