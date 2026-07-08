import { Suspense, useEffect } from 'react';
import { Link, Route, Routes, useLocation, useNavigate } from 'react-router-dom';
import { captureReferralFromSearch } from './lib/referral';
import { lazyWithReload } from './lib/lazyWithReload';
import { useAuth } from './context/AuthContext';
import RequireAuth from './components/RequireAuth';
import RequireAdmin from './components/RequireAdmin';
import AdminLayout from './components/AdminLayout';
import RequireAgency from './components/RequireAgency';
import AgencyLayout from './components/AgencyLayout';
import RequireReferralAccess from './components/RequireReferralAccess';
import Footer from './components/Footer';
import ErrorBoundary from './components/ErrorBoundary';
import './App.css';

// ページ単位でコード分割し、初回表示時に不要なコード(管理画面・代理店ポータル等)を
// ダウンロードさせない(仕様書外の拡張。表示速度改善)。
// lazyWithReloadは、デプロイ直後のチャンク読み込み失敗時に自動で1回だけ再読み込みする。
const ProductListPage = lazyWithReload(() => import('./pages/ProductListPage'));
const ProductDetailPage = lazyWithReload(() => import('./pages/ProductDetailPage'));
const CartPage = lazyWithReload(() => import('./pages/CartPage'));
const CheckoutPage = lazyWithReload(() => import('./pages/CheckoutPage'));
const CheckoutSuccessPage = lazyWithReload(() => import('./pages/CheckoutSuccessPage'));
const CheckoutCancelPage = lazyWithReload(() => import('./pages/CheckoutCancelPage'));
const LoginPage = lazyWithReload(() => import('./pages/LoginPage'));
const RegisterPage = lazyWithReload(() => import('./pages/RegisterPage'));
const PasswordResetRequestPage = lazyWithReload(() => import('./pages/PasswordResetRequestPage'));
const PasswordResetConfirmPage = lazyWithReload(() => import('./pages/PasswordResetConfirmPage'));
const MyPage = lazyWithReload(() => import('./pages/MyPage'));
const WalletPage = lazyWithReload(() => import('./pages/WalletPage'));
const MyProfilePage = lazyWithReload(() => import('./pages/MyProfilePage'));
const ReceiptPage = lazyWithReload(() => import('./pages/ReceiptPage'));
const AdminDashboardPage = lazyWithReload(() => import('./pages/admin/AdminDashboardPage'));
const AdminProductsPage = lazyWithReload(() => import('./pages/admin/AdminProductsPage'));
const AdminImportProductsPage = lazyWithReload(() => import('./pages/admin/AdminImportProductsPage'));
const AdminOrdersPage = lazyWithReload(() => import('./pages/admin/AdminOrdersPage'));
const AdminNftIssuesPage = lazyWithReload(() => import('./pages/admin/AdminNftIssuesPage'));
const AdminWalletMissingPage = lazyWithReload(() => import('./pages/admin/AdminWalletMissingPage'));
const AdminNoticesPage = lazyWithReload(() => import('./pages/admin/AdminNoticesPage'));
const AdminReferralLinksPage = lazyWithReload(() => import('./pages/admin/AdminReferralLinksPage'));
const AdminReferralsPage = lazyWithReload(() => import('./pages/admin/AdminReferralsPage'));
const AdminAgenciesPage = lazyWithReload(() => import('./pages/admin/AdminAgenciesPage'));
const AdminSettingsPage = lazyWithReload(() => import('./pages/admin/AdminSettingsPage'));
const AdminLegalPage = lazyWithReload(() => import('./pages/admin/AdminLegalPage'));
const AdminAuditLogsPage = lazyWithReload(() => import('./pages/admin/AdminAuditLogsPage'));
const AdminUsersPage = lazyWithReload(() => import('./pages/admin/AdminUsersPage'));
const AgencyReferralLinksPage = lazyWithReload(() => import('./pages/agency/AgencyReferralLinksPage'));
const AgencyOrdersPage = lazyWithReload(() => import('./pages/agency/AgencyOrdersPage'));
const InviteOnlyPage = lazyWithReload(() => import('./pages/InviteOnlyPage'));
const LandingPage = lazyWithReload(() => import('./pages/LandingPage'));
const TokushohoPage = lazyWithReload(() => import('./pages/legal/TokushohoPage'));
const TermsPage = lazyWithReload(() => import('./pages/legal/TermsPage'));
const RefundPolicyPage = lazyWithReload(() => import('./pages/legal/RefundPolicyPage'));
const PrivacyPolicyPage = lazyWithReload(() => import('./pages/legal/PrivacyPolicyPage'));

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
        <ErrorBoundary>
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
        </ErrorBoundary>
      </main>
      <Footer />
    </>
  );
}

export default App;
