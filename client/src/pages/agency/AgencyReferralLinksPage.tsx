import { useEffect, useRef, useState } from 'react';
import {
  createAgencyReferralLink,
  fetchAgencyInfluencers,
  fetchAgencyLandingOptions,
  fetchAgencyReferralLinks,
  type AgencyReferralLink,
} from '../../lib/agencyApi';
import StatusBadge from '../../components/StatusBadge';
import QrCodeImage from '../../components/QrCodeImage';

const NEW_INFLUENCER = '__new__';
const NONE_INFLUENCER = '__none__';

function lineShareUrl(url: string): string {
  return `https://social-plugins.line.me/lineit/share?url=${encodeURIComponent(url)}`;
}

export default function AgencyReferralLinksPage() {
  const [influencers, setInfluencers] = useState<{ id: string; name: string }[]>([]);
  const [landingOptions, setLandingOptions] = useState<{ path: string; label: string }[]>([]);
  const [links, setLinks] = useState<AgencyReferralLink[] | null>(null);
  const [autoCreating, setAutoCreating] = useState(false);

  const [showAdvanced, setShowAdvanced] = useState(false);
  const [influencerSelection, setInfluencerSelection] = useState(NONE_INFLUENCER);
  const [newInfluencerName, setNewInfluencerName] = useState('');
  const [commissionRate, setCommissionRate] = useState('');
  const [landingPath, setLandingPath] = useState('/products/council-nft');
  const [error, setError] = useState<string | null>(null);
  const [created, setCreated] = useState<AgencyReferralLink | null>(null);
  const [copiedId, setCopiedId] = useState<string | null>(null);
  const autoCreateAttempted = useRef(false);

  function loadLinks() {
    return fetchAgencyReferralLinks().then((d) => {
      setLinks(d.referralLinks);
      return d.referralLinks;
    });
  }

  useEffect(() => {
    fetchAgencyInfluencers().then((d) => setInfluencers(d.influencers));
    fetchAgencyLandingOptions().then((d) => setLandingOptions(d.options));

    // 初めて代理店ポータルを開いた場合、複雑な設定なしで使える紹介URLを自動で1つ発行しておく。
    // StrictModeの二重実行でも1回しか発行されないようrefでガードする。
    loadLinks().then((existing) => {
      if (existing.length === 0 && !autoCreateAttempted.current) {
        autoCreateAttempted.current = true;
        setAutoCreating(true);
        createAgencyReferralLink({ influencer: null, commission_rate: null, landing_path: '/products/council-nft' })
          .then(() => loadLinks())
          .finally(() => setAutoCreating(false));
      }
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setCreated(null);

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

  async function copyUrl(id: string, url: string) {
    await navigator.clipboard.writeText(url);
    setCopiedId(id);
  }

  if (links === null || autoCreating) {
    return <p>読み込み中です...</p>;
  }

  // 最初に発行された(=一番古い)リンクを、シンプルな「あなたの紹介URL」として案内する。
  const mainLink = links[links.length - 1];
  const otherLinks = links.slice(0, links.length - 1);

  return (
    <div className="referral-links-page">
      <h1>紹介URL発行</h1>

      {mainLink && (
        <div className="referral-links-main">
          <p className="referral-links-main__label">あなたの紹介URLはこちらです</p>
          <p className="referral-links-url referral-links-main__url">{mainLink.url}</p>
          <div className="referral-links-main__actions">
            <button type="button" className="btn-primary" onClick={() => copyUrl(mainLink.id, mainLink.url)}>
              {copiedId === mainLink.id ? 'コピーしました' : 'URLをコピー'}
            </button>
            <a className="btn-secondary" href={lineShareUrl(mainLink.url)} target="_blank" rel="noreferrer">
              LINEで送る
            </a>
          </div>
          <QrCodeImage value={mainLink.url} />
          <p className="admin-settings-help">このURLからご購入いただくと、あなたの紹介実績として記録されます。</p>
        </div>
      )}

      <details className="referral-links-advanced" open={showAdvanced} onToggle={(e) => setShowAdvanced(e.currentTarget.open)}>
        <summary>詳細設定(インフルエンサー別・商品別にURLを分けたい場合)</summary>

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
            新しいURLを発行する
          </button>
        </form>

        {created && (
          <div className="referral-links-result">
            <p>発行しました(コード: {created.code} / 適用報酬率: {created.resolvedCommissionRate}%)</p>
            <p className="referral-links-url">{created.url}</p>
            <button type="button" className="btn-small" onClick={() => copyUrl(created.id, created.url)}>
              {copiedId === created.id ? 'コピーしました' : 'URLをコピー'}
            </button>
          </div>
        )}

        {otherLinks.length > 0 && (
          <>
            <h2>その他の発行済みリンク</h2>
            <ul className="referral-links-list">
              {otherLinks.map((link) => (
                <li key={link.id}>
                  <div>
                    <strong>{link.code}</strong> <StatusBadge status={link.status} />
                  </div>
                  <div className="referral-links-url">{link.url}</div>
                  <button type="button" className="btn-secondary btn-small" onClick={() => copyUrl(link.id, link.url)}>
                    {copiedId === link.id ? 'コピーしました' : 'URLをコピー'}
                  </button>
                  <div>
                    インフルエンサー: {link.influencerName ?? '-'} / 報酬率: {link.resolvedCommissionRate}%
                  </div>
                </li>
              ))}
            </ul>
          </>
        )}
      </details>
    </div>
  );
}
