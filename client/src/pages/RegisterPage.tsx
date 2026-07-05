import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useAuth } from '../context/AuthContext';

export default function RegisterPage() {
  const { register } = useAuth();
  const navigate = useNavigate();
  const [name, setName] = useState('');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [phone, setPhone] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setSubmitting(true);
    setError(null);
    try {
      await register(name, email, password, phone);
      navigate('/products');
    } catch (e) {
      setError(e instanceof Error ? e.message : '会員登録に失敗しました');
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <form className="checkout-page" onSubmit={handleSubmit}>
      <h1>会員登録</h1>

      <label>
        氏名
        <input type="text" value={name} onChange={(e) => setName(e.target.value)} required />
      </label>

      <label>
        メールアドレス
        <input type="email" value={email} onChange={(e) => setEmail(e.target.value)} required />
      </label>

      <label>
        パスワード(8文字以上)
        <input type="password" value={password} onChange={(e) => setPassword(e.target.value)} minLength={8} required />
      </label>

      <label>
        電話番号
        <input type="tel" value={phone} onChange={(e) => setPhone(e.target.value)} />
      </label>

      {error && <p className="checkout-error">{error}</p>}

      <button type="submit" disabled={submitting}>
        {submitting ? '登録中...' : '登録する'}
      </button>
    </form>
  );
}
