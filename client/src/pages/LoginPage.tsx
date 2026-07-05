import { useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { useAuth } from '../context/AuthContext';

export default function LoginPage() {
  const { login } = useAuth();
  const navigate = useNavigate();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setSubmitting(true);
    setError(null);
    try {
      await login(email, password);
      navigate('/products');
    } catch (e) {
      setError(e instanceof Error ? e.message : 'ログインに失敗しました');
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <form className="checkout-page" onSubmit={handleSubmit}>
      <h1>ログイン</h1>

      <label>
        メールアドレス
        <input type="email" value={email} onChange={(e) => setEmail(e.target.value)} required />
      </label>

      <label>
        パスワード
        <input type="password" value={password} onChange={(e) => setPassword(e.target.value)} required />
      </label>

      {error && <p className="checkout-error">{error}</p>}

      <button type="submit" disabled={submitting}>
        {submitting ? 'ログイン中...' : 'ログイン'}
      </button>

      <p>
        <Link to="/password-reset">パスワードをお忘れの方はこちら</Link>
      </p>
      <p>
        アカウントをお持ちでない方は<Link to="/register">会員登録</Link>
      </p>
    </form>
  );
}
