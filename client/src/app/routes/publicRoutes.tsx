import { Route } from 'react-router-dom';
import { lazyWithReload } from '../../lib/lazyWithReload';
import RequireReferralAccess from '../../components/RequireReferralAccess';

const LandingPage = lazyWithReload(() => import('../../pages/LandingPage'));
const InviteOnlyPage = lazyWithReload(() => import('../../pages/InviteOnlyPage'));
const ProductListPage = lazyWithReload(() => import('../../pages/ProductListPage'));
const ProductDetailPage = lazyWithReload(() => import('../../pages/ProductDetailPage'));
const CartPage = lazyWithReload(() => import('../../pages/CartPage'));
const CheckoutPage = lazyWithReload(() => import('../../pages/CheckoutPage'));
const CheckoutSuccessPage = lazyWithReload(() => import('../../pages/CheckoutSuccessPage'));
const CheckoutCancelPage = lazyWithReload(() => import('../../pages/CheckoutCancelPage'));
const LoginPage = lazyWithReload(() => import('../../pages/LoginPage'));
const RegisterPage = lazyWithReload(() => import('../../pages/RegisterPage'));
const PasswordResetRequestPage = lazyWithReload(() => import('../../pages/PasswordResetRequestPage'));
const PasswordResetConfirmPage = lazyWithReload(() => import('../../pages/PasswordResetConfirmPage'));
const TokushohoPage = lazyWithReload(() => import('../../pages/legal/TokushohoPage'));
const TermsPage = lazyWithReload(() => import('../../pages/legal/TermsPage'));
const RefundPolicyPage = lazyWithReload(() => import('../../pages/legal/RefundPolicyPage'));
const PrivacyPolicyPage = lazyWithReload(() => import('../../pages/legal/PrivacyPolicyPage'));

// 一般公開ページ(ログイン不要)。<Routes>の子要素として直接呼び出す(コンポーネントとして
// レンダリングすると<Routes>がRoute子要素を検出できないため、関数として呼び出しFragmentを返す)。
export function publicRoutes() {
  return (
    <>
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
    </>
  );
}
