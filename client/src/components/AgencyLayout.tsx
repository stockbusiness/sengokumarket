import { NavLink, Outlet } from 'react-router-dom';

const NAV_ITEMS = [{ to: '/agency', label: '紹介URL発行', end: true }];

export default function AgencyLayout() {
  return (
    <div className="admin-layout">
      <nav className="admin-nav">
        {NAV_ITEMS.map((item) => (
          <NavLink
            key={item.to}
            to={item.to}
            end={item.end}
            className={({ isActive }) => (isActive ? 'admin-nav__link admin-nav__link--active' : 'admin-nav__link')}
          >
            {item.label}
          </NavLink>
        ))}
      </nav>
      <div className="admin-content">
        <Outlet />
      </div>
    </div>
  );
}
