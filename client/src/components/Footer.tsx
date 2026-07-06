import { Link } from 'react-router-dom';

export default function Footer() {
  return (
    <footer className="site-footer">
      <Link to="/legal/tokushoho">特定商取引法に基づく表記</Link>
      <Link to="/legal/terms">利用規約</Link>
      <Link to="/legal/refund">返金ポリシー</Link>
      <Link to="/legal/privacy">プライバシーポリシー</Link>
    </footer>
  );
}
