import { useEffect } from 'react';
import { Link, Navigate, Route, Routes, useLocation, useNavigate } from 'react-router-dom';
import { captureReferralFromSearch } from './lib/referral';
import { useAuth } from './context/AuthContext';
import ProductListPage from './pages/ProductListPage';
import ProductDetailPage from './pages/ProductDetailPage';
import CartPage from './pages/CartPage';
import CheckoutPage from './pages/CheckoutPage';
import CheckoutSuccessPage from './pages/CheckoutSuccessPage';
import CheckoutCancelPage from './pages/CheckoutCancelPage';
import LoginPage from './pages/LoginPage';
import RegisterPage from './pages/RegisterPage';
import PasswordResetRequestPage from './pages/PasswordResetRequestPage';
import PasswordResetConfirmPage from './pages/PasswordResetConfirmPage';
import MyPage from './pages/MyPage';
import WalletPage from './pages/WalletPage';
import RequireAuth from './components/RequireAuth';
import './App.css';

function NavBar() {
  const { user, logout } = useAuth();
  const navigate = useNavigate();

  return (
    <nav className="nav-bar">
      <Link to="/products">商品一覧</Link>
      <Link to="/cart">カート</Link>
      {user ? (
        <>
          <Link to="/mypage">マイページ</Link>
          <span>{user.name}さん</span>
          <button
            type="button"
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
          <Link to="/register">会員登録</Link>
        </>
      )}
    </nav>
  );
}

function App() {
  const location = useLocation();

  useEffect(() => {
    captureReferralFromSearch(location.search);
  }, [location.search]);

  return (
    <>
      <NavBar />
      <Routes>
        <Route path="/" element={<Navigate to="/products" replace />} />
        <Route path="/products" element={<ProductListPage />} />
        <Route path="/products/:idOrSlug" element={<ProductDetailPage />} />
        <Route path="/cart" element={<CartPage />} />
        <Route path="/checkout" element={<CheckoutPage />} />
        <Route path="/checkout/success" element={<CheckoutSuccessPage />} />
        <Route path="/checkout/cancel" element={<CheckoutCancelPage />} />
        <Route path="/login" element={<LoginPage />} />
        <Route path="/register" element={<RegisterPage />} />
        <Route path="/password-reset" element={<PasswordResetRequestPage />} />
        <Route path="/password-reset/confirm" element={<PasswordResetConfirmPage />} />
        <Route
          path="/mypage"
          element={
            <RequireAuth>
              <MyPage />
            </RequireAuth>
          }
        />
        <Route
          path="/mypage/wallet"
          element={
            <RequireAuth>
              <WalletPage />
            </RequireAuth>
          }
        />
      </Routes>
    </>
  );
}

export default App;
