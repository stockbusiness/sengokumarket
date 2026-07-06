import { Link } from 'react-router-dom';

export default function Footer() {
  return (
    <footer className="site-footer">
      <div className="site-footer__inner">
        <nav className="site-footer__links">
          <Link to="/legal/tokushoho">特定商取引法に基づく表記</Link>
          <Link to="/legal/terms">利用規約</Link>
          <Link to="/legal/refund">返金ポリシー</Link>
          <Link to="/legal/privacy">プライバシーポリシー</Link>
        </nav>
        <p className="site-footer__copyright">戦国経済圏</p>
      </div>
    </footer>
  );
}
