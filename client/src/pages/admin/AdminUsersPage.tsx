import { useEffect, useState } from 'react';
import { useAuth } from '../../context/AuthContext';
import {
  createAdminUser,
  deleteAdminUser,
  fetchAdminUsers,
  resendAdminUserSetupEmail,
  updateAdminUserRole,
  type AdminUser,
} from '../../lib/adminApi';
import EmptyState from '../../components/EmptyState';

const ROLE_LABEL: Record<AdminUser['role'], string> = { admin: '管理者', admin_viewer: '閲覧専用管理者', staff: 'スタッフ' };

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
  const [pendingUserId, setPendingUserId] = useState<string | null>(null);

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

  async function handleResend(target: AdminUser) {
    setError(null);
    setMessage(null);
    setPendingUserId(target.id);
    try {
      await resendAdminUserSetupEmail(target.id);
      setMessage(`${target.name}さんにパスワード設定メールを再送しました。`);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'メールの再送に失敗しました');
    } finally {
      setPendingUserId(null);
    }
  }

  async function handleDelete(target: AdminUser) {
    if (!window.confirm(`${target.name}さん(${target.email})のアカウントを削除します。よろしいですか？`)) return;

    setError(null);
    setMessage(null);
    setPendingUserId(target.id);
    try {
      await deleteAdminUser(target.id);
      setMessage(`${target.name}さんのアカウントを削除しました。`);
      load();
    } catch (err) {
      setError(err instanceof Error ? err.message : '削除に失敗しました');
    } finally {
      setPendingUserId(null);
    }
  }

  return (
    <div>
      <h1>管理者アカウント</h1>
      <p>
        管理者アカウントには3種類あります。「管理者」は全機能の登録・変更が可能、「閲覧専用管理者」は全機能を閲覧のみできます。
        「スタッフ」は商品・注文・NFT発行・お知らせ等の日次業務のみ操作でき、この画面や決済/メール設定・監査ログ・紹介リンク発行・
        クーポン管理・代理店関連の機能は利用できません。
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
              <option value="staff">スタッフ</option>
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
                {isFullAdmin && <th>操作</th>}
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
                        <option value="staff">スタッフ</option>
                        <option value="admin">管理者</option>
                      </select>
                    ) : (
                      ROLE_LABEL[u.role]
                    )}
                  </td>
                  {isFullAdmin && (
                    <td>
                      <button
                        type="button"
                        className="btn-secondary btn-small"
                        disabled={pendingUserId === u.id}
                        onClick={() => handleResend(u)}
                      >
                        設定メール再送
                      </button>{' '}
                      {u.id !== user?.id && (
                        <button
                          type="button"
                          className="btn-secondary btn-small"
                          disabled={pendingUserId === u.id}
                          onClick={() => handleDelete(u)}
                        >
                          削除
                        </button>
                      )}
                    </td>
                  )}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
