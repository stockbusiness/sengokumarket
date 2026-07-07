import { Link } from 'react-router-dom';

const BENEFITS = [
  {
    title: '評議員としての証明',
    body: '戦国経済圏の評議員であることを示すデジタル会員証を、ご自身の受取用ウォレットで大切に保管いただけます。',
  },
  {
    title: '限定コンテンツ・情報のご案内',
    body: '評議員向けのお知らせやご案内を、マイページを通じてお届けします。',
  },
  {
    title: '専任担当による丁寧なサポート',
    body: 'お申し込みからお受け取りまで、ご案内窓口の担当者が丁寧にサポートいたします。',
  },
];

const FAQS = [
  {
    q: 'どなたでもお申し込みいただけますか?',
    a: '現在は提携代理店・ご担当者様からご案内するURLを通じてのみお申し込みを受け付けております。お申し込みご希望の方は、お心当たりの代理店ご担当者様にお問い合わせください。',
  },
  {
    q: 'お支払い方法を教えてください。',
    a: 'クレジットカードでのお支払いに対応しております(Stripe社の決済システムを利用)。',
  },
  {
    q: 'デジタル会員証はどのように受け取りますか?',
    a: 'お申し込み完了後、マイページから受取用ウォレットのアドレスをご登録いただきます。ご登録内容を確認のうえ、順次発行いたします。',
  },
  {
    q: 'キャンセル・返金はできますか?',
    a: (
      <>
        <Link to="/legal/refund">返金ポリシー</Link>をご確認のうえ、ご案内窓口までお問い合わせください。
      </>
    ),
  },
];

export default function LandingPage() {
  return (
    <div className="landing-page">
      <section className="landing-hero">
        <p className="landing-hero__eyebrow">戦国経済圏</p>
        <h1>評議員デジタル会員証</h1>
        <p className="landing-hero__lead">
          戦国経済圏にご参加いただく評議員の皆様に向けた、デジタル会員証のお申し込みページです。
        </p>
        <Link to="/products" className="btn-primary landing-hero__cta">
          お申し込みはこちら
        </Link>
      </section>

      <section className="landing-section">
        <h2>評議員デジタル会員証について</h2>
        <p>
          評議員デジタル会員証は、戦国経済圏の評議員であることを証明するために発行するデジタル形式の会員証です。
          お申し込み後、ご登録いただいた受取用ウォレットに発行し、いつでもご自身で保管・確認いただけます。
        </p>
      </section>

      <section className="landing-section">
        <h2>ご提供内容</h2>
        <ul className="landing-benefits">
          {BENEFITS.map((b) => (
            <li key={b.title} className="landing-benefits__item">
              <h3>{b.title}</h3>
              <p>{b.body}</p>
            </li>
          ))}
        </ul>
      </section>

      <section className="landing-section">
        <h2>よくあるご質問</h2>
        <dl className="landing-faq">
          {FAQS.map((f) => (
            <div key={f.q} className="landing-faq__item">
              <dt>{f.q}</dt>
              <dd>{f.a}</dd>
            </div>
          ))}
        </dl>
      </section>

      <section className="landing-section landing-section--cta">
        <Link to="/products" className="btn-primary landing-hero__cta">
          お申し込みはこちら
        </Link>
        <p>
          既に会員登録がお済みの方は<Link to="/login">こちらからログイン</Link>してください。
        </p>
      </section>
    </div>
  );
}
