import { useEffect, useState } from 'react';
import { fetchMyWallet, updateMyWallet } from '../lib/api';

const WALLET_ADDRESS_RE = /^0x[a-fA-F0-9]{40}$/;

export default function WalletPage() {
  const [currentAddress, setCurrentAddress] = useState<string | null>(null);
  const [walletAddress, setWalletAddress] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [confirming, setConfirming] = useState(false);
  const [submitting, setSubmitting] = useState(false);

  useEffect(() => {
    fetchMyWallet().then((d) => {
      if (d.wallet) {
        setCurrentAddress(d.wallet.walletAddress);
        setWalletAddress(d.wallet.walletAddress);
      }
    });
  }, []);

  function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setMessage(null);

    if (!WALLET_ADDRESS_RE.test(walletAddress)) {
      setError('ウォレットアドレスの形式が正しくありません(0xで始まる42文字)');
      return;
    }

    if (currentAddress) {
      setConfirming(true);
      return;
    }

    void doSubmit();
  }

  async function doSubmit() {
    setSubmitting(true);
    setConfirming(false);
    try {
      const data = await updateMyWallet(walletAddress);
      setCurrentAddress(data.wallet.walletAddress);
      setMessage('受取用ウォレットを登録しました。');
    } catch (e) {
      setError(e instanceof Error ? e.message : '登録に失敗しました');
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div className="checkout-page">
      <h1>受取用ウォレットの登録</h1>
      <p>デジタル会員証(NFT)の受け取りに使用するウォレットアドレスを登録してください。</p>

      <form onSubmit={handleSubmit}>
        <label>
          チェーン種別
          <select value="polygon" disabled>
            <option value="polygon">Polygon</option>
          </select>
        </label>

        <label>
          ウォレットアドレス
          <input
            type="text"
            value={walletAddress}
            onChange={(e) => setWalletAddress(e.target.value)}
            placeholder="0xで始まる42文字のアドレス"
            required
          />
        </label>

        {error && <p className="checkout-error">{error}</p>}
        {message && <p>{message}</p>}

        <button type="submit" disabled={submitting}>
          {submitting ? '登録中...' : currentAddress ? '更新する' : '登録する'}
        </button>
      </form>

      {confirming && (
        <div className="wallet-confirm-modal">
          <p>ウォレットアドレスを更新します。発行済みのNFTには影響しません。よろしいですか?</p>
          <button type="button" onClick={() => void doSubmit()}>
            更新する
          </button>
          <button type="button" onClick={() => setConfirming(false)}>
            キャンセル
          </button>
        </div>
      )}
    </div>
  );
}
