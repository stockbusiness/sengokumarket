import { NavLink, Outlet, useNavigate } from 'react-router-dom';
import { useEffect, useState } from 'react';
import { useAuth } from '../context/AuthContext';
import { fetchAdminDashboard } from '../lib/adminApi';
import { IconBell, IconSearch } from './icons';

type BadgeKey = 'walletMissing' | 'alerts';

const NAV_GROUPS: { heading: string; items: { to: string; label: string; end?: boolean; badgeKey?: BadgeKey }[] }[] = [
  { heading: '概要', items: [{ to: '/admin', label: 'ダッシュボード', end: true }] },
  {
    heading: '商品・注文',
    items: [
      { to: '/admin/products', label: '商品管理' },
      { to: '/admin/import-products', label: 'CSV商品インポート' },
      { to: '/admin/orders', label: '注文管理' },
    ],
  },
  {
    heading: 'NFT',
    items: [
      { to: '/admin/nft-issues', label: 'NFT発行管理' },
      { to: '/admin/wallet-missing', label: 'ウォレット未登録一覧', badgeKey: 'walletMissing' },
    ],
  },
  {
    heading: '紹介・代理店',
    items: [
      { to: '/admin/referral-links', label: '紹介リンク発行' },
      { to: '/admin/referrals', label: '代理店・紹介成果', badgeKey: 'alerts' },
      { to: '/admin/agencies', label: '代理店一覧' },
    ],
  },
  {
    heading: 'その他',
    items: [
      { to: '/admin/notices', label: 'お知らせ管理' },
      { to: '/admin/legal', label: '法務ページ編集' },
      { to: '/admin/settings', label: '決済・メール設定' },
    ],
  },
];

export default function AdminLayout() {
  const { user, logout } = useAuth();
  const navigate = useNavigate();
  const [walletMissingCount, setWalletMissingCount] = useState(0);
  const [alertCount, setAlertCount] = useState(0);

  useEffect(() => {
    fetchAdminDashboard().then((d) => {
      setWalletMissingCount(d.walletMissingCount);
      setAlertCount(d.alerts.partialRefundCount + d.alerts.commissionRecoveryCount);
    });
  }, []);

  const badgeCounts: Record<BadgeKey, number> = { walletMissing: walletMissingCount, alerts: alertCount };

  return (
    <div className="admin-layout">
      <nav className="admin-nav">
        {NAV_GROUPS.map((group) => (
          <div className="admin-nav__group" key={group.heading}>
            <div className="admin-nav__heading">{group.heading}</div>
            {group.items.map((item) => (
              <NavLink
                key={item.to}
                to={item.to}
                end={item.end}
                className={({ isActive }) => (isActive ? 'admin-nav__link admin-nav__link--active' : 'admin-nav__link')}
              >
                {item.label}
                {item.badgeKey && badgeCounts[item.badgeKey] > 0 && <span className="admin-nav__dot" aria-hidden="true" />}
              </NavLink>
            ))}
          </div>
        ))}
      </nav>
      <div className="admin-main">
        <div className="admin-topbar">
          <label className="admin-topbar__search">
            <IconSearch />
            <input type="text" placeholder="検索(準備中)" disabled />
          </label>
          <div className="admin-topbar__right">
            <span className="admin-topbar__bell" aria-label={`要対応アラート${alertCount}件`}>
              <IconBell />
              {alertCount > 0 && <span className="admin-topbar__bell-badge">{alertCount}</span>}
            </span>
            <span className="admin-topbar__user">{user?.name}さん</span>
            <button
              type="button"
              className="btn-secondary btn-small"
              onClick={async () => {
                await logout();
                navigate('/login');
              }}
            >
              ログアウト
            </button>
          </div>
        </div>
        <div className="admin-content">
          <Outlet />
        </div>
      </div>
    </div>
  );
}
