import { useState } from 'react';
import { requestPasswordReset } from '../lib/api';

export default function PasswordResetRequestPage() {
  const [email, setEmail] = useState('');
  const [message, setMessage] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setSubmitting(true);
    try {
      const data = await requestPasswordReset(email);
      setMessage(data.message);
    } catch {
      // 存在有無を問わず同じ案内にする(仕様書v1.5 4.8)
      setMessage('パスワード再設定用のメールを送信しました(該当するアカウントが存在する場合)');
    } finally {
      setSubmitting(false);
    }
  }

  if (message) {
    return (
      <div className="checkout-page">
        <h1>パスワード再設定</h1>
        <p>{message}</p>
      </div>
    );
  }

  return (
    <form className="checkout-page" onSubmit={handleSubmit}>
      <h1>パスワード再設定</h1>
      <label>
        メールアドレス
        <input type="email" value={email} onChange={(e) => setEmail(e.target.value)} required />
      </label>
      <button type="submit" disabled={submitting}>
        {submitting ? '送信中...' : '再設定メールを送信'}
      </button>
    </form>
  );
}
