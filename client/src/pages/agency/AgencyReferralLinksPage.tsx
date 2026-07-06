import { useEffect, useState } from 'react';
import {
  createAgencyReferralLink,
  fetchAgencyInfluencers,
  fetchAgencyLandingOptions,
  fetchAgencyReferralLinks,
  type AgencyReferralLink,
} from '../../lib/agencyApi';

const NEW_INFLUENCER = '__new__';
const NONE_INFLUENCER = '__none__';

export default function AgencyReferralLinksPage() {
  const [influencers, setInfluencers] = useState<{ id: string; name: string }[]>([]);
  const [landingOptions, setLandingOptions] = useState<{ path: string; label: string }[]>([]);
  const [links, setLinks] = useState<AgencyReferralLink[]>([]);

  const [influencerSelection, setInfluencerSelection] = useState(NONE_INFLUENCER);
  const [newInfluencerName, setNewInfluencerName] = useState('');
  const [commissionRate, setCommissionRate] = useState('');
  const [landingPath, setLandingPath] = useState('/products/council-nft');
  const [error, setError] = useState<string | null>(null);
  const [created, setCreated] = useState<AgencyReferralLink | null>(null);
  const [copied, setCopied] = useState(false);

  function loadLinks() {
    fetchAgencyReferralLinks().then((d) => setLinks(d.referralLinks));
  }

  useEffect(() => {
    fetchAgencyInfluencers().then((d) => setInfluencers(d.influencers));
    fetchAgencyLandingOptions().then((d) => setLandingOptions(d.options));
    loadLinks();
  }, []);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setCreated(null);
    setCopied(false);

    try {
      const result = await createAgencyReferralLink({
        influencer:
          influencerSelection === NEW_INFLUENCER
            ? { new_name: newInfluencerName }
            : influencerSelection === NONE_INFLUENCER
              ? null
              : { id: influencerSelection },
        commission_rate: commissionRate ? Number(commissionRate) : null,
        landing_path: landingPath,
      });
      setCreated(result.referralLink);
      loadLinks();
    } catch (e) {
      setError(e instanceof Error ? e.message : '発行に失敗しました');
    }
  }

  async function copyUrl(url: string) {
    await navigator.clipboard.writeText(url);
    setCopied(true);
  }

  return (
    <div className="referral-links-page">
      <h1>紹介URL発行</h1>

      <form onSubmit={handleSubmit} className="referral-links-form">
        <label>
          インフルエンサー
          <select value={influencerSelection} onChange={(e) => setInfluencerSelection(e.target.value)}>
            <option value={NONE_INFLUENCER}>なし(代理店のみ)</option>
            {influencers.map((i) => (
              <option key={i.id} value={i.id}>
                {i.name}
              </option>
            ))}
            <option value={NEW_INFLUENCER}>+ 新規作成</option>
          </select>
        </label>

        {influencerSelection === NEW_INFLUENCER && (
          <label>
            新規インフルエンサー名
            <input type="text" value={newInfluencerName} onChange={(e) => setNewInfluencerName(e.target.value)} required />
          </label>
        )}

        <label>
          報酬率(任意。空欄なら自動継承)
          <input type="number" value={commissionRate} onChange={(e) => setCommissionRate(e.target.value)} />
        </label>

        <label>
          ランディング先
          <select value={landingPath} onChange={(e) => setLandingPath(e.target.value)}>
            <option value="/products/council-nft">/products/council-nft(デフォルト)</option>
            {landingOptions.map((o) => (
              <option key={o.path} value={o.path}>
                {o.label}({o.path})
              </option>
            ))}
          </select>
        </label>

        {error && <p className="checkout-error">{error}</p>}

        <button type="submit" className="btn-primary">
          発行する
        </button>
      </form>

      {created && (
        <div className="referral-links-result">
          <p>発行しました(コード: {created.code} / 適用報酬率: {created.resolvedCommissionRate}%)</p>
          <p className="referral-links-url">{created.url}</p>
          <button type="button" onClick={() => copyUrl(created.url)}>
            {copied ? 'コピーしました' : 'URLをコピー'}
          </button>
        </div>
      )}

      <h2>発行済みリンク一覧</h2>
      <ul className="referral-links-list">
        {links.map((link) => (
          <li key={link.id}>
            <div>
              <strong>{link.code}</strong>({link.status})
            </div>
            <div className="referral-links-url">{link.url}</div>
            <button type="button" onClick={() => copyUrl(link.url)}>
              URLをコピー
            </button>
            <div>
              インフルエンサー: {link.influencerName ?? '-'} / 報酬率: {link.resolvedCommissionRate}%
            </div>
          </li>
        ))}
      </ul>
    </div>
  );
}
