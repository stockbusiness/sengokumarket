import { lazy, Suspense, useEffect } from 'react';
import { Link, Route, Routes, useLocation, useNavigate } from 'react-router-dom';
import { captureReferralFromSearch } from './lib/referral';
import { useAuth } from './context/AuthContext';
import RequireAuth from './components/RequireAuth';
import RequireAdmin from './components/RequireAdmin';
import AdminLayout from './components/AdminLayout';
import RequireAgency from './components/RequireAgency';
import AgencyLayout from './components/AgencyLayout';
import RequireReferralAccess from './components/RequireReferralAccess';
import Footer from './components/Footer';
import './App.css';

// ページ単位でコード分割し、初回表示時に不要なコード(管理画面・代理店ポータル等)を
// ダウンロードさせない(仕様書外の拡張。表示速度改善)。
const ProductListPage = lazy(() => import('./pages/ProductListPage'));
const ProductDetailPage = lazy(() => import('./pages/ProductDetailPage'));
const CartPage = lazy(() => import('./pages/CartPage'));
const CheckoutPage = lazy(() => import('./pages/CheckoutPage'));
const CheckoutSuccessPage = lazy(() => import('./pages/CheckoutSuccessPage'));
const CheckoutCancelPage = lazy(() => import('./pages/CheckoutCancelPage'));
const LoginPage = lazy(() => import('./pages/LoginPage'));
const RegisterPage = lazy(() => import('./pages/RegisterPage'));
const PasswordResetRequestPage = lazy(() => import('./pages/PasswordResetRequestPage'));
const PasswordResetConfirmPage = lazy(() => import('./pages/PasswordResetConfirmPage'));
const MyPage = lazy(() => import('./pages/MyPage'));
const WalletPage = lazy(() => import('./pages/WalletPage'));
const MyProfilePage = lazy(() => import('./pages/MyProfilePage'));
const ReceiptPage = lazy(() => import('./pages/ReceiptPage'));
const AdminDashboardPage = lazy(() => import('./pages/admin/AdminDashboardPage'));
const AdminProductsPage = lazy(() => import('./pages/admin/AdminProductsPage'));
const AdminImportProductsPage = lazy(() => import('./pages/admin/AdminImportProductsPage'));
const AdminOrdersPage = lazy(() => import('./pages/admin/AdminOrdersPage'));
const AdminNftIssuesPage = lazy(() => import('./pages/admin/AdminNftIssuesPage'));
const AdminWalletMissingPage = lazy(() => import('./pages/admin/AdminWalletMissingPage'));
const AdminNoticesPage = lazy(() => import('./pages/admin/AdminNoticesPage'));
const AdminReferralLinksPage = lazy(() => import('./pages/admin/AdminReferralLinksPage'));
const AdminReferralsPage = lazy(() => import('./pages/admin/AdminReferralsPage'));
const AdminAgenciesPage = lazy(() => import('./pages/admin/AdminAgenciesPage'));
const AdminSettingsPage = lazy(() => import('./pages/admin/AdminSettingsPage'));
const AdminLegalPage = lazy(() => import('./pages/admin/AdminLegalPage'));
const AdminAuditLogsPage = lazy(() => import('./pages/admin/AdminAuditLogsPage'));
const AdminUsersPage = lazy(() => import('./pages/admin/AdminUsersPage'));
const AgencyReferralLinksPage = lazy(() => import('./pages/agency/AgencyReferralLinksPage'));
const AgencyOrdersPage = lazy(() => import('./pages/agency/AgencyOrdersPage'));
const InviteOnlyPage = lazy(() => import('./pages/InviteOnlyPage'));
const LandingPage = lazy(() => import('./pages/LandingPage'));
const TokushohoPage = lazy(() => import('./pages/legal/TokushohoPage'));
const TermsPage = lazy(() => import('./pages/legal/TermsPage'));
const RefundPolicyPage = lazy(() => import('./pages/legal/RefundPolicyPage'));
const PrivacyPolicyPage = lazy(() => import('./pages/legal/PrivacyPolicyPage'));

function NavBar() {
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
              {(user.role === 'admin' || user.role === 'admin_viewer') && <Link to="/admin">管理画面</Link>}
              {user.role === 'agency' && <Link to="/agency">代理店ポータル</Link>}
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

function App() {
  const location = useLocation();

  useEffect(() => {
    captureReferralFromSearch(location.search);
  }, [location.search]);

  return (
    <>
      <NavBar />
      <main className="app-main">
        <Suspense fallback={<p className="page-loading">読み込み中です...</p>}>
        <Routes>
        <Route path="/" element={<LandingPage />} />
        <Route path="/invite-only" element={<InviteOnlyPage />} />
        <Route
          path="/products"
          element={
            <RequireReferralAccess>
              <ProductListPage />
            </RequireReferralAccess>
          }
        />
        <Route
          path="/products/:idOrSlug"
          element={
            <RequireReferralAccess>
              <ProductDetailPage />
            </RequireReferralAccess>
          }
        />
        <Route
          path="/cart"
          element={
            <RequireReferralAccess>
              <CartPage />
            </RequireReferralAccess>
          }
        />
        <Route
          path="/checkout"
          element={
            <RequireReferralAccess>
              <CheckoutPage />
            </RequireReferralAccess>
          }
        />
        <Route path="/checkout/success" element={<CheckoutSuccessPage />} />
        <Route path="/checkout/cancel" element={<CheckoutCancelPage />} />
        <Route path="/login" element={<LoginPage />} />
        <Route
          path="/register"
          element={
            <RequireReferralAccess>
              <RegisterPage />
            </RequireReferralAccess>
          }
        />
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
          path="/mypage/profile"
          element={
            <RequireAuth>
              <MyProfilePage />
            </RequireAuth>
          }
        />
        <Route
          path="/mypage/orders/:id/receipt"
          element={
            <RequireAuth>
              <ReceiptPage />
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
          <Route path="agencies" element={<AdminAgenciesPage />} />
          <Route path="settings" element={<AdminSettingsPage />} />
          <Route path="legal" element={<AdminLegalPage />} />
          <Route path="audit-logs" element={<AdminAuditLogsPage />} />
          <Route path="admin-users" element={<AdminUsersPage />} />
        </Route>
        <Route
          path="/agency"
          element={
            <RequireAgency>
              <AgencyLayout />
            </RequireAgency>
          }
        >
          <Route index element={<AgencyReferralLinksPage />} />
          <Route path="orders" element={<AgencyOrdersPage />} />
        </Route>
        </Routes>
        </Suspense>
      </main>
      <Footer />
    </>
  );
}

export default App;
