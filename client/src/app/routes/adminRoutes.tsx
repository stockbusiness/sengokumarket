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
const AdminNotificationOutboxPage = lazyWithReload(() => import('../../pages/admin/AdminNotificationOutboxPage'));
const AdminOrderLinkingJobsPage = lazyWithReload(() => import('../../pages/admin/AdminOrderLinkingJobsPage'));
const AdminPurchaseProvisioningPage = lazyWithReload(() => import('../../pages/admin/AdminPurchaseProvisioningPage'));
const AdminIntegrationOutboxPage = lazyWithReload(() => import('../../pages/admin/AdminIntegrationOutboxPage'));
const AdminIntegrationRulesOverviewPage = lazyWithReload(() => import('../../pages/admin/AdminIntegrationRulesOverviewPage'));
const AdminExternalIdentityConflictsPage = lazyWithReload(() => import('../../pages/admin/AdminExternalIdentityConflictsPage'));
const AdminWalletTransactionsPage = lazyWithReload(() => import('../../pages/admin/AdminWalletTransactionsPage'));
const AdminIntegrationPreflightPage = lazyWithReload(() => import('../../pages/admin/AdminIntegrationPreflightPage'));
const AdminWalletClaimsPage = lazyWithReload(() => import('../../pages/admin/AdminWalletClaimsPage'));
const AdminWalletClaimDetailPage = lazyWithReload(() => import('../../pages/admin/AdminWalletClaimDetailPage'));
const AdminCollectibleDeliveriesPage = lazyWithReload(() => import('../../pages/admin/AdminCollectibleDeliveriesPage'));
const AdminCollectibleDeliveryDetailPage = lazyWithReload(() => import('../../pages/admin/AdminCollectibleDeliveryDetailPage'));

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
      {/* 本番安定化指示書Stage11(14.1「管理・監視画面」): 外部連携の運用・監視系はstaffには
          公開しない(AdminLayoutのNAV_GROUPS.staffHiddenと対応)。 */}
      <Route
        path="notification-outbox"
        element={
          <RequireFullAdmin>
            <AdminNotificationOutboxPage />
          </RequireFullAdmin>
        }
      />
      <Route
        path="order-linking-jobs"
        element={
          <RequireFullAdmin>
            <AdminOrderLinkingJobsPage />
          </RequireFullAdmin>
        }
      />
      <Route
        path="purchase-provisioning"
        element={
          <RequireFullAdmin>
            <AdminPurchaseProvisioningPage />
          </RequireFullAdmin>
        }
      />
      <Route
        path="external-identity-conflicts"
        element={
          <RequireFullAdmin>
            <AdminExternalIdentityConflictsPage />
          </RequireFullAdmin>
        }
      />
      <Route
        path="integration-outbox"
        element={
          <RequireFullAdmin>
            <AdminIntegrationOutboxPage />
          </RequireFullAdmin>
        }
      />
      <Route
        path="integration-rules"
        element={
          <RequireFullAdmin>
            <AdminIntegrationRulesOverviewPage />
          </RequireFullAdmin>
        }
      />
      <Route
        path="wallet-transactions"
        element={
          <RequireFullAdmin>
            <AdminWalletTransactionsPage />
          </RequireFullAdmin>
        }
      />
      <Route
        path="integration-preflight"
        element={
          <RequireFullAdmin>
            <AdminIntegrationPreflightPage />
          </RequireFullAdmin>
        }
      />
      {/* 戦国マーケット NFTカード受取・送付 実装指示書(2026-07-25)19章「管理画面」。 */}
      <Route
        path="wallet-claims"
        element={
          <RequireFullAdmin>
            <AdminWalletClaimsPage />
          </RequireFullAdmin>
        }
      />
      <Route
        path="wallet-claims/:id"
        element={
          <RequireFullAdmin>
            <AdminWalletClaimDetailPage />
          </RequireFullAdmin>
        }
      />
      <Route
        path="collectible-deliveries"
        element={
          <RequireFullAdmin>
            <AdminCollectibleDeliveriesPage />
          </RequireFullAdmin>
        }
      />
      <Route
        path="collectible-deliveries/:id"
        element={
          <RequireFullAdmin>
            <AdminCollectibleDeliveryDetailPage />
          </RequireFullAdmin>
        }
      />
    </Route>
  );
}
