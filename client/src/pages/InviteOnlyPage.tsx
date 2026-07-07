import { Link } from 'react-router-dom';

export default function InviteOnlyPage() {
  return (
    <div className="legal-page">
      <h1>ご案内</h1>
      <p>
        戦国楽市楽座の評議員デジタル会員証は、提携代理店からご案内するURLを通じてのみお申し込みいただけます。
        お心当たりの代理店ご担当者様より届いたURLからアクセスしてください。
      </p>
      <p>
        既に会員登録がお済みの方は<Link to="/login">こちらからログイン</Link>してください。
      </p>
    </div>
  );
}
