import { useState } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import { useAuth } from '../context/AuthContext';

// 仕様書外の拡張(先方仕様書v3.6.45): 代理店システムからのSSOログイン失敗時、
// /login?error=<code> で渡されるエラーコードの案内文。
const SSO_ERROR_MESSAGES: Record<string, string> = {
  agency_not_linked: '代理店ポータルとの連携が見つかりません。運営までお問い合わせください。',
  agency_inactive: 'この代理店は現在停止中です。運営までお問い合わせください。',
  sso_expired: 'ログイン用リンクの有効期限が切れています。もう一度代理店システムからログインし直してください。',
  sso_replayed: 'このログイン用リンクは既に使用されています。もう一度代理店システムからログインし直してください。',
  sso_invalid: 'ログインに失敗しました。もう一度代理店システムからログインし直してください。',
};

export default function LoginPage() {
  const { login } = useAuth();
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const ssoError = searchParams.get('error');
  const [error, setError] = useState<string | null>(ssoError ? (SSO_ERROR_MESSAGES[ssoError] ?? SSO_ERROR_MESSAGES.sso_invalid) : null);
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

      <button type="submit" className="btn-primary" disabled={submitting}>
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
