import { useEffect, useState } from 'react';
import { useAuth } from '../context/AuthContext';
import { updateMyProfile } from '../lib/api';

export default function MyProfilePage() {
  const { user, refresh } = useAuth();
  const [name, setName] = useState('');
  const [phone, setPhone] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  useEffect(() => {
    if (user) {
      setName(user.name);
      setPhone(user.phone ?? '');
    }
  }, [user]);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setMessage(null);

    if (name.trim().length === 0) {
      setError('氏名を入力してください');
      return;
    }

    setSubmitting(true);
    try {
      await updateMyProfile({ name: name.trim(), phone: phone.trim() });
      await refresh();
      setMessage('登録内容を更新しました。');
    } catch (err) {
      setError(err instanceof Error ? err.message : '更新に失敗しました');
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div className="checkout-page">
      <h1>登録情報の編集</h1>
      <p>氏名・電話番号を変更できます。メールアドレスの変更はご案内窓口までお問い合わせください。</p>

      <form onSubmit={handleSubmit}>
        <label>
          氏名
          <input type="text" value={name} onChange={(e) => setName(e.target.value)} required />
        </label>

        <label>
          電話番号
          <input type="tel" value={phone} onChange={(e) => setPhone(e.target.value)} placeholder="090-1234-5678" />
        </label>

        <label>
          メールアドレス
          <input type="email" value={user?.email ?? ''} disabled />
        </label>

        {error && <p className="checkout-error">{error}</p>}
        {message && <p>{message}</p>}

        <button type="submit" className="btn-primary" disabled={submitting}>
          {submitting ? '更新中...' : '更新する'}
        </button>
      </form>
    </div>
  );
}
