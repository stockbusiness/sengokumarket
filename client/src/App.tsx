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
import RequireAdmin from './components/RequireAdmin';
import AdminLayout from './components/AdminLayout';
import AdminDashboardPage from './pages/admin/AdminDashboardPage';
import AdminProductsPage from './pages/admin/AdminProductsPage';
import AdminImportProductsPage from './pages/admin/AdminImportProductsPage';
import AdminOrdersPage from './pages/admin/AdminOrdersPage';
import AdminNftIssuesPage from './pages/admin/AdminNftIssuesPage';
import AdminWalletMissingPage from './pages/admin/AdminWalletMissingPage';
import AdminNoticesPage from './pages/admin/AdminNoticesPage';
import AdminReferralLinksPage from './pages/admin/AdminReferralLinksPage';
import AdminReferralsPage from './pages/admin/AdminReferralsPage';
import AdminSettingsPage from './pages/admin/AdminSettingsPage';
import Footer from './components/Footer';
import TokushohoPage from './pages/legal/TokushohoPage';
import TermsPage from './pages/legal/TermsPage';
import RefundPolicyPage from './pages/legal/RefundPolicyPage';
import PrivacyPolicyPage from './pages/legal/PrivacyPolicyPage';
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
          {user.role === 'admin' && <Link to="/admin">管理画面</Link>}
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
        <Route path="/legal/tokushoho" element={<TokushohoPage />} />
        <Route path="/legal/terms" element={<TermsPage />} />
        <Route path="/legal/refund" element={<RefundPolicyPage />} />
        <Route path="/legal/privacy" element={<PrivacyPolicyPage />} />
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
        <Route
          path="/admin"
          element={
            <RequireAdmin>
              <AdminLayout />
            </RequireAdmin>
          }
        >
          <Route index element={<AdminDashboardPage />} />
          <Route path="products" element={<AdminProductsPage />} />
          <Route path="import-products" element={<AdminImportProductsPage />} />
          <Route path="orders" element={<AdminOrdersPage />} />
          <Route path="nft-issues" element={<AdminNftIssuesPage />} />
          <Route path="wallet-missing" element={<AdminWalletMissingPage />} />
          <Route path="notices" element={<AdminNoticesPage />} />
          <Route path="referral-links" element={<AdminReferralLinksPage />} />
          <Route path="referrals" element={<AdminReferralsPage />} />
          <Route path="settings" element={<AdminSettingsPage />} />
        </Route>
      </Routes>
      <Footer />
    </>
  );
}

export default App;
