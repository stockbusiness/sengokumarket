import { useEffect, useRef } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { useAuth, AgencySsoError } from '../../context/AuthContext';

// 仕様書外の拡張(先方仕様書v3.6.45): 代理店システム(IdP)からのSSOリダイレクト受け口。
// トークンをAPIに渡してセッションを確立し、URLからtokenが消える画面へ遷移する。
export default function AgencySsoCallbackPage() {
  const [searchParams] = useSearchParams();
  const navigate = useNavigate();
  const { loginWithAgencySso } = useAuth();
  const attempted = useRef(false);

  useEffect(() => {
    if (attempted.current) return;
    attempted.current = true;

    const token = searchParams.get('token');
    if (!token) {
      navigate('/login?error=sso_invalid', { replace: true });
      return;
    }

    loginWithAgencySso(token)
      .then((returnTo) => {
        navigate(returnTo ?? '/agency', { replace: true });
      })
      .catch((e) => {
        const code = e instanceof AgencySsoError ? e.code : 'sso_invalid';
        navigate(`/login?error=${code}`, { replace: true });
      });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return <p>ログイン処理中です...</p>;
}
