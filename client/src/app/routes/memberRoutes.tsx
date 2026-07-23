import { Route } from 'react-router-dom';
import { lazyWithReload } from '../../lib/lazyWithReload';
import RequireAuth from '../../components/RequireAuth';

const MyPage = lazyWithReload(() => import('../../pages/MyPage'));
const WalletPage = lazyWithReload(() => import('../../pages/WalletPage'));
const MyProfilePage = lazyWithReload(() => import('../../pages/MyProfilePage'));
const ReceiptPage = lazyWithReload(() => import('../../pages/ReceiptPage'));

// ログイン会員向けページ(マイページ関連)。
export function memberRoutes() {
  return (
    <>
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
    </>
  );
}
