import { Route } from 'react-router-dom';
import { lazyWithReload } from '../../lib/lazyWithReload';
import RequireAgency from '../../components/RequireAgency';
import AgencyLayout from '../../components/AgencyLayout';

const AgencyReferralLinksPage = lazyWithReload(() => import('../../pages/agency/AgencyReferralLinksPage'));
const AgencyOrdersPage = lazyWithReload(() => import('../../pages/agency/AgencyOrdersPage'));
const AgencySsoCallbackPage = lazyWithReload(() => import('../../pages/agency/AgencySsoCallbackPage'));

// 代理店ポータル(/agency)。
export function agencyRoutes() {
  return (
    <>
      <Route path="/agency/sso" element={<AgencySsoCallbackPage />} />
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
    </>
  );
}
