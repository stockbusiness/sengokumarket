import { Link, Outlet } from 'react-router-dom';

const NAV_ITEMS = [
  { to: '/admin', label: 'ダッシュボード' },
  { to: '/admin/products', label: '商品管理' },
  { to: '/admin/orders', label: '注文管理' },
  { to: '/admin/nft-issues', label: 'NFT発行管理' },
  { to: '/admin/wallet-missing', label: 'ウォレット未登録' },
  { to: '/admin/notices', label: 'お知らせ管理' },
  { to: '/admin/referral-links', label: '紹介リンク発行' },
  { to: '/admin/referrals', label: '代理店・紹介成果' },
  { to: '/admin/settings', label: '決済・メール設定' },
];

export default function AdminLayout() {
  return (
    <div className="admin-layout">
      <nav className="admin-nav">
        {NAV_ITEMS.map((item) => (
          <Link key={item.to} to={item.to}>
            {item.label}
          </Link>
        ))}
      </nav>
      <div className="admin-content">
        <Outlet />
      </div>
    </div>
  );
}
