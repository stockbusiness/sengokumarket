import { useEffect, useState } from 'react';
import { useAuth } from '../../context/AuthContext';
import { createAdminUser, fetchAdminUsers, updateAdminUserRole, type AdminUser } from '../../lib/adminApi';
import EmptyState from '../../components/EmptyState';

const ROLE_LABEL: Record<AdminUser['role'], string> = { admin: '管理者', admin_viewer: '閲覧専用管理者' };

export default function AdminUsersPage() {
  const { user } = useAuth();
  const isFullAdmin = user?.role === 'admin';

  const [adminUsers, setAdminUsers] = useState<AdminUser[]>([]);
  const [name, setName] = useState('');
  const [email, setEmail] = useState('');
  const [role, setRole] = useState<AdminUser['role']>('admin_viewer');
  const [error, setError] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  function load() {
    fetchAdminUsers().then((d) => setAdminUsers(d.adminUsers));
  }
  useEffect(load, []);

  async function handleCreate(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setMessage(null);
    setSubmitting(true);
    try {
      await createAdminUser({ name, email, role });
      setName('');
      setEmail('');
      setRole('admin_viewer');
      setMessage('アカウントを作成しました。パスワード設定メールを送信しました。');
      load();
    } catch (err) {
      setError(err instanceof Error ? err.message : '作成に失敗しました');
    } finally {
      setSubmitting(false);
    }
  }

  async function handleRoleChange(target: AdminUser, newRole: AdminUser['role']) {
    setError(null);
    try {
      await updateAdminUserRole(target.id, newRole);
      load();
    } catch (err) {
      setError(err instanceof Error ? err.message : '権限の変更に失敗しました');
    }
  }

  return (
    <div>
      <h1>管理者アカウント</h1>
      <p>
        管理者には「管理者(登録・変更が可能)」と「閲覧専用管理者(閲覧のみ)」の2種類があります。
        閲覧専用管理者は管理画面の全ての情報を確認できますが、登録・変更・削除操作はできません。
      </p>

      {isFullAdmin && (
        <form onSubmit={handleCreate} className="admin-form-card">
          <label>
            氏名
            <input type="text" value={name} onChange={(e) => setName(e.target.value)} required />
          </label>
          <label>
            メールアドレス
            <input type="email" value={email} onChange={(e) => setEmail(e.target.value)} required />
          </label>
          <label>
            権限
            <select value={role} onChange={(e) => setRole(e.target.value as AdminUser['role'])}>
              <option value="admin_viewer">閲覧専用管理者</option>
              <option value="admin">管理者</option>
            </select>
          </label>
          {error && <p className="checkout-error">{error}</p>}
          {message && <p>{message}</p>}
          <button type="submit" className="btn-primary" disabled={submitting}>
            {submitting ? '作成中...' : 'アカウントを作成する'}
          </button>
        </form>
      )}

      {adminUsers.length === 0 ? (
        <div className="admin-table-card">
          <EmptyState message="管理者アカウントがありません" />
        </div>
      ) : (
        <div className="admin-table-card">
          <table>
            <thead>
              <tr>
                <th>氏名</th>
                <th>メールアドレス</th>
                <th>権限</th>
              </tr>
            </thead>
            <tbody>
              {adminUsers.map((u) => (
                <tr key={u.id}>
                  <td>{u.name}</td>
                  <td>{u.email}</td>
                  <td>
                    {isFullAdmin && u.id !== user?.id ? (
                      <select value={u.role} onChange={(e) => handleRoleChange(u, e.target.value as AdminUser['role'])}>
                        <option value="admin_viewer">閲覧専用管理者</option>
                        <option value="admin">管理者</option>
                      </select>
                    ) : (
                      ROLE_LABEL[u.role]
                    )}
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
