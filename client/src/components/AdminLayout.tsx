import { NavLink, Outlet } from 'react-router-dom';
import { useEffect, useState } from 'react';
import { fetchAdminDashboard } from '../lib/adminApi';
import { useAuth } from '../context/AuthContext';
import {
  IconBell,
  IconBox,
  IconBuilding,
  IconChart,
  IconDocument,
  IconGear,
  IconGrid,
  IconHistory,
  IconLink,
  IconMegaphone,
  IconReceipt,
  IconSearch,
  IconUpload,
  IconBadge,
  IconUser,
  IconWallet,
  IconYen,
} from './icons';
import type { ComponentType, SVGProps } from 'react';

type BadgeKey = 'walletMissing' | 'alerts';
type IconType = ComponentType<SVGProps<SVGSVGElement>>;

const NAV_GROUPS: {
  heading: string;
  items: { to: string; label: string; icon: IconType; end?: boolean; badgeKey?: BadgeKey; muted?: boolean; staffHidden?: boolean }[];
}[] = [
  { heading: '概要', items: [{ to: '/admin', label: 'ダッシュボード', icon: IconGrid, end: true }] },
  {
    heading: '商品・注文',
    items: [
      { to: '/admin/products', label: '商品管理', icon: IconBox },
      { to: '/admin/import-products', label: 'CSV商品インポート', icon: IconUpload },
      { to: '/admin/orders', label: '注文管理', icon: IconReceipt },
    ],
  },
  {
    heading: 'NFT',
    items: [
      { to: '/admin/external-orders', label: '外部購入者の取り込み', icon: IconUpload },
      { to: '/admin/nft-issues', label: 'NFT発行管理', icon: IconBadge },
      { to: '/admin/wallet-missing', label: 'ウォレット未登録一覧', icon: IconWallet, badgeKey: 'walletMissing' },
    ],
  },
  {
    // 仕様書外の拡張: スタッフ(staff)は紹介・代理店関連の機能を一切利用できない。
    heading: '紹介・代理店',
    items: [
      { to: '/admin/referral-links', label: '紹介リンク発行', icon: IconLink, staffHidden: true },
      { to: '/admin/coupons', label: 'クーポン管理', icon: IconYen, staffHidden: true },
      { to: '/admin/referrals', label: '代理店・紹介成果', icon: IconChart, badgeKey: 'alerts', staffHidden: true },
      { to: '/admin/agencies', label: '代理店一覧', icon: IconBuilding, staffHidden: true },
    ],
  },
  {
    heading: 'その他',
    items: [
      { to: '/admin/notices', label: 'お知らせ管理', icon: IconMegaphone },
      { to: '/admin/legal', label: '法務ページ編集', icon: IconDocument, muted: true, staffHidden: true },
      { to: '/admin/settings', label: '決済・メール設定', icon: IconGear, muted: true, staffHidden: true },
      { to: '/admin/audit-logs', label: '監査ログ', icon: IconHistory, muted: true, staffHidden: true },
      { to: '/admin/admin-users', label: '管理者アカウント', icon: IconUser, muted: true, staffHidden: true },
    ],
  },
];

export default function AdminLayout() {
  const { user } = useAuth();
  const [walletMissingCount, setWalletMissingCount] = useState(0);
  const [alertCount, setAlertCount] = useState(0);

  useEffect(() => {
    fetchAdminDashboard().then((d) => {
      setWalletMissingCount(d.walletMissingCount);
      setAlertCount(d.alerts.partialRefundCount + d.alerts.commissionRecoveryCount);
    });
  }, []);

  const badgeCounts: Record<BadgeKey, number> = { walletMissing: walletMissingCount, alerts: alertCount };
  const isStaff = user?.role === 'staff';
  const visibleNavGroups = NAV_GROUPS.map((group) => ({
    ...group,
    items: group.items.filter((item) => !(isStaff && item.staffHidden)),
  })).filter((group) => group.items.length > 0);

  return (
    <div className="admin-layout">
      <nav className="admin-nav">
        {visibleNavGroups.map((group) => (
          <div className="admin-nav__group" key={group.heading}>
            <div className="admin-nav__heading">{group.heading}</div>
            {group.items.map((item) => {
              const Icon = item.icon;
              return (
                <NavLink
                  key={item.to}
                  to={item.to}
                  end={item.end}
                  className={({ isActive }) => {
                    const classes = ['admin-nav__link'];
                    if (isActive) classes.push('admin-nav__link--active');
                    if (item.muted) classes.push('admin-nav__link--muted');
                    return classes.join(' ');
                  }}
                >
                  <Icon className="admin-nav__icon" />
                  {item.label}
                  {item.badgeKey && badgeCounts[item.badgeKey] > 0 && <span className="admin-nav__dot" aria-hidden="true" />}
                </NavLink>
              );
            })}
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
          </div>
        </div>
        <div className="admin-content">
          {user?.role === 'admin_viewer' && (
            <div className="admin-viewer-banner">閲覧専用アカウントでログイン中です。登録・変更・削除操作はできません。</div>
          )}
          {isStaff && (
            <div className="admin-viewer-banner">
              スタッフアカウントでログイン中です。商品・注文・NFT発行・お知らせ以外の機能は利用できません。
            </div>
          )}
          <Outlet />
        </div>
      </div>
    </div>
  );
}
