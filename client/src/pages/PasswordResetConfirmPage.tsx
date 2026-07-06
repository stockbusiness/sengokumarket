import { useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { confirmPasswordReset } from '../lib/api';

export default function PasswordResetConfirmPage() {
  const [searchParams] = useSearchParams();
  const token = searchParams.get('token') ?? '';
  const navigate = useNavigate();
  const [newPassword, setNewPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setSubmitting(true);
    setError(null);
    try {
      await confirmPasswordReset(token, newPassword);
      navigate('/login');
    } catch (e) {
      setError(e instanceof Error ? e.message : 'パスワードの再設定に失敗しました');
    } finally {
      setSubmitting(false);
    }
  }

  if (!token) {
    return <p>リンクが正しくありません。メール記載のリンクから再度アクセスしてください。</p>;
  }

  return (
    <form className="checkout-page" onSubmit={handleSubmit}>
      <h1>新しいパスワードの設定</h1>
      <label>
        新しいパスワード(8文字以上)
        <input
          type="password"
          value={newPassword}
          onChange={(e) => setNewPassword(e.target.value)}
          minLength={8}
          required
        />
      </label>
      {error && <p className="checkout-error">{error}</p>}
      <button type="submit" className="btn-primary" disabled={submitting}>
        {submitting ? '設定中...' : 'パスワードを設定する'}
      </button>
    </form>
  );
}
