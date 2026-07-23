import { Link, useNavigate } from 'react-router-dom';
import { useAuth } from '../context/AuthContext';
import { canAccessAdmin, canAccessAgencyPortal } from './permissions';

export default function NavBar() {
  const { user, logout } = useAuth();
  const navigate = useNavigate();

  return (
    <header className="site-header">
      <nav className="nav-bar">
        <Link to="/" className="brand">
          <span className="brand__mark" aria-hidden="true" />
          <span className="brand__name">戦国楽市楽座</span>
        </Link>
        <div className="nav-bar__links">
          <Link to="/products">商品一覧</Link>
          <Link to="/cart">カート</Link>
          {user ? (
            <>
              <Link to="/mypage">マイページ</Link>
              {/* 仕様書外の拡張(保守性改善Phase 1): RequireAdminが実際に許可するroleと
                  一致させる(以前はstaffがRequireAdminでは入室できるのにリンクが出ない不整合があった)。 */}
              {canAccessAdmin(user.role) && <Link to="/admin">管理画面</Link>}
              {canAccessAgencyPortal(user.role) && <Link to="/agency">代理店ポータル</Link>}
              <span className="nav-bar__user">{user.name}さん</span>
              <button
                type="button"
                className="btn-secondary btn-small"
                onClick={async () => {
                  await logout();
                  navigate('/products');
                }}
              >
                ログアウト
              </button>
            </>
          ) : (
            <>
              <Link to="/login">ログイン</Link>
              <Link to="/register" className="btn-primary btn-small">
                会員登録
              </Link>
            </>
          )}
        </div>
      </nav>
    </header>
  );
}
