import { NavLink, Outlet } from 'react-router-dom';
import { useEffect, useState } from 'react';
import { fetchAdminDashboard } from '../lib/adminApi';
import { useAuth } from '../context/AuthContext';
import { canAccessFullAdmin } from '../app/permissions';
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

type BadgeKey = 'walletMissing' | 'alerts' | 'integrationAlerts' | 'commonIdConflicts';
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
  {
    // 本番安定化指示書Stage11(14章): 外部連携(千ノ国全体連携)の運用・監視画面。
    // 現時点ではSENNOKUNI_INTEGRATION_ENABLED=falseのdormant機能のため、日次業務には不要。
    heading: '外部連携・監視',
    items: [
      { to: '/admin/integration-preflight', label: '連携Preflight・段階設定', icon: IconGear, staffHidden: true },
      { to: '/admin/integration-outbox', label: 'Integration Outbox', icon: IconChart, badgeKey: 'integrationAlerts', staffHidden: true },
      { to: '/admin/order-linking-jobs', label: 'Order Linking Jobs', icon: IconLink, staffHidden: true },
      { to: '/admin/purchase-provisioning', label: '代理店ポータル連携ジョブ', icon: IconLink, staffHidden: true },
      {
        to: '/admin/external-identity-conflicts',
        label: '共通ID競合',
        icon: IconUser,
        badgeKey: 'commonIdConflicts',
        staffHidden: true,
      },
      { to: '/admin/wallet-transactions', label: 'OVEウォレット取引履歴', icon: IconWallet, staffHidden: true },
      { to: '/admin/integration-rules', label: '商品連携ルール一覧', icon: IconBox, staffHidden: true },
      { to: '/admin/wallet-claims', label: 'Wallet Claims', icon: IconBadge, staffHidden: true },
      { to: '/admin/collectible-deliveries', label: 'Collectible Deliveries', icon: IconWallet, staffHidden: true },
      { to: '/admin/notification-outbox', label: '通知Outbox', icon: IconMegaphone, muted: true, staffHidden: true },
    ],
  },
];

export default function AdminLayout() {
  const { user } = useAuth();
  const [walletMissingCount, setWalletMissingCount] = useState(0);
  const [alertCount, setAlertCount] = useState(0);
  const [integrationAlertCount, setIntegrationAlertCount] = useState(0);
  const [commonIdConflictCount, setCommonIdConflictCount] = useState(0);

  useEffect(() => {
    fetchAdminDashboard().then((d) => {
      setWalletMissingCount(d.walletMissingCount);
      setAlertCount(d.alerts.partialRefundCount + d.alerts.commissionRecoveryCount);
      // 本番安定化指示書Stage11(14.3「アラート」)。
      setIntegrationAlertCount(
        d.alerts.deadNotificationCount + d.alerts.deadLinkingJobCount + d.alerts.deadIntegrationEventCount + d.alerts.blockedIntegrationEventCount,
      );
      setCommonIdConflictCount(d.alerts.commonIdConflictCount);
    });
  }, []);

  const badgeCounts: Record<BadgeKey, number> = {
    walletMissing: walletMissingCount,
    alerts: alertCount,
    integrationAlerts: integrationAlertCount,
    commonIdConflicts: commonIdConflictCount,
  };
  // RequireAdminの内側でのみ描画される(=roleはadmin/admin_viewer/staffのいずれか)ため、
  // !canAccessFullAdminはstaffと同義になる。
  const isStaff = !!user && !canAccessFullAdmin(user.role);
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
