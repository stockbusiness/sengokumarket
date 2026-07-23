import { Route } from 'react-router-dom';
import { lazyWithReload } from '../../lib/lazyWithReload';
import RequireAdmin from '../../components/RequireAdmin';
import RequireFullAdmin from '../../components/RequireFullAdmin';
import AdminLayout from '../../components/AdminLayout';

const AdminDashboardPage = lazyWithReload(() => import('../../pages/admin/AdminDashboardPage'));
const AdminProductsPage = lazyWithReload(() => import('../../pages/admin/AdminProductsPage'));
const AdminProductCreatePage = lazyWithReload(() => import('../../pages/admin/AdminProductCreatePage'));
const AdminProductEditPage = lazyWithReload(() => import('../../pages/admin/AdminProductEditPage'));
const AdminImportProductsPage = lazyWithReload(() => import('../../pages/admin/AdminImportProductsPage'));
const AdminOrdersPage = lazyWithReload(() => import('../../pages/admin/AdminOrdersPage'));
const AdminExternalOrdersPage = lazyWithReload(() => import('../../pages/admin/AdminExternalOrdersPage'));
const AdminNftIssuesPage = lazyWithReload(() => import('../../pages/admin/AdminNftIssuesPage'));
const AdminWalletMissingPage = lazyWithReload(() => import('../../pages/admin/AdminWalletMissingPage'));
const AdminNoticesPage = lazyWithReload(() => import('../../pages/admin/AdminNoticesPage'));
const AdminReferralLinksPage = lazyWithReload(() => import('../../pages/admin/AdminReferralLinksPage'));
const AdminCouponsPage = lazyWithReload(() => import('../../pages/admin/AdminCouponsPage'));
const AdminReferralsPage = lazyWithReload(() => import('../../pages/admin/AdminReferralsPage'));
const AdminAgenciesPage = lazyWithReload(() => import('../../pages/admin/AdminAgenciesPage'));
const AdminSettingsPage = lazyWithReload(() => import('../../pages/admin/AdminSettingsPage'));
const AdminLegalPage = lazyWithReload(() => import('../../pages/admin/AdminLegalPage'));
const AdminAuditLogsPage = lazyWithReload(() => import('../../pages/admin/AdminAuditLogsPage'));
const AdminUsersPage = lazyWithReload(() => import('../../pages/admin/AdminUsersPage'));

// 管理画面(/admin)。日次業務系(staffも利用可)とadmin/admin_viewer専用機能に分かれる
// (どの機能がstaffに公開されるかはAdminLayoutのNAV_GROUPS.staffHiddenと、各RouteのRequireFullAdmin
// の有無で二重に表現される。個別ルートのRequireFullAdminがサーバー側403の画面側での再現)。
export function adminRoutes() {
  return (
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
      <Route path="products/new" element={<AdminProductCreatePage />} />
      <Route path="products/:id/edit" element={<AdminProductEditPage />} />
      <Route path="import-products" element={<AdminImportProductsPage />} />
      <Route path="orders" element={<AdminOrdersPage />} />
      <Route path="external-orders" element={<AdminExternalOrdersPage />} />
      <Route path="nft-issues" element={<AdminNftIssuesPage />} />
      <Route path="wallet-missing" element={<AdminWalletMissingPage />} />
      <Route path="notices" element={<AdminNoticesPage />} />
      <Route
        path="referral-links"
        element={
          <RequireFullAdmin>
            <AdminReferralLinksPage />
          </RequireFullAdmin>
        }
      />
      <Route
        path="coupons"
        element={
          <RequireFullAdmin>
            <AdminCouponsPage />
          </RequireFullAdmin>
        }
      />
      <Route
        path="referrals"
        element={
          <RequireFullAdmin>
            <AdminReferralsPage />
          </RequireFullAdmin>
        }
      />
      <Route
        path="agencies"
        element={
          <RequireFullAdmin>
            <AdminAgenciesPage />
          </RequireFullAdmin>
        }
      />
      <Route
        path="settings"
        element={
          <RequireFullAdmin>
            <AdminSettingsPage />
          </RequireFullAdmin>
        }
      />
      <Route
        path="legal"
        element={
          <RequireFullAdmin>
            <AdminLegalPage />
          </RequireFullAdmin>
        }
      />
      <Route
        path="audit-logs"
        element={
          <RequireFullAdmin>
            <AdminAuditLogsPage />
          </RequireFullAdmin>
        }
      />
      <Route
        path="admin-users"
        element={
          <RequireFullAdmin>
            <AdminUsersPage />
          </RequireFullAdmin>
        }
      />
    </Route>
  );
}
