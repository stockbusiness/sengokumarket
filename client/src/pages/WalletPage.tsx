import { useEffect, useState } from 'react';
import { fetchMyWallet, registerVerifiedWallet, requestWalletVerificationNonce, type MyWallet } from '../lib/api';

// window.ethereumの型定義はこのページでのみ必要な最小限のものに留める(新規依存追加を避けるため)。
interface InjectedProvider {
  request(args: { method: string; params?: unknown[] }): Promise<unknown>;
}

function getInjectedProvider(): InjectedProvider | null {
  const ethereum = (window as unknown as { ethereum?: InjectedProvider }).ethereum;
  return ethereum ?? null;
}

export default function WalletPage() {
  const [currentWallet, setCurrentWallet] = useState<MyWallet | null>(null);
  const [connectedAddress, setConnectedAddress] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [confirming, setConfirming] = useState(false);
  const [connecting, setConnecting] = useState(false);
  const [signing, setSigning] = useState(false);

  useEffect(() => {
    fetchMyWallet().then((d) => setCurrentWallet(d.wallet));
  }, []);

  async function handleConnect() {
    setError(null);
    setMessage(null);
    const provider = getInjectedProvider();
    if (!provider) {
      setError('対応するウォレット拡張機能が見つかりません(MetaMask等をブラウザにインストールしてください)');
      return;
    }
    setConnecting(true);
    try {
      const accounts = (await provider.request({ method: 'eth_requestAccounts' })) as string[];
      if (!accounts?.[0]) throw new Error('ウォレットのアドレスを取得できませんでした');
      setConnectedAddress(accounts[0]);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'ウォレットへの接続に失敗しました');
    } finally {
      setConnecting(false);
    }
  }

  function handleRegisterClick() {
    setError(null);
    setMessage(null);
    if (!connectedAddress) return;

    if (currentWallet && currentWallet.walletAddress.toLowerCase() !== connectedAddress.toLowerCase()) {
      setConfirming(true);
      return;
    }
    void doSign();
  }

  async function doSign() {
    if (!connectedAddress) return;
    const provider = getInjectedProvider();
    if (!provider) {
      setError('対応するウォレット拡張機能が見つかりません');
      return;
    }
    setSigning(true);
    setConfirming(false);
    try {
      const { message: challengeMessage } = await requestWalletVerificationNonce(connectedAddress);
      const signature = (await provider.request({
        method: 'personal_sign',
        params: [challengeMessage, connectedAddress],
      })) as string;
      const data = await registerVerifiedWallet(connectedAddress, signature);
      setCurrentWallet(data.wallet);
      setConnectedAddress(null);
      setMessage('受取用ウォレットを確認・登録しました。');
    } catch (e) {
      setError(e instanceof Error ? e.message : '署名または登録に失敗しました');
    } finally {
      setSigning(false);
    }
  }

  return (
    <div className="checkout-page">
      <h1>受取用ウォレットの登録</h1>
      <p>デジタル会員証(NFT)の受け取りに使用するウォレットを接続し、ご本人であることを確認(署名)してください。</p>

      {currentWallet && (
        <p>
          登録済みのウォレット: {currentWallet.walletAddress}
          {currentWallet.verified ? '(確認済み)' : '(未確認)'}
        </p>
      )}

      {!connectedAddress ? (
        <button type="button" className="btn-primary" onClick={() => void handleConnect()} disabled={connecting}>
          {connecting ? '接続中...' : 'ウォレットに接続する'}
        </button>
      ) : (
        <div>
          <p>接続中のアドレス: {connectedAddress}</p>
          <button type="button" className="btn-primary" onClick={handleRegisterClick} disabled={signing}>
            {signing ? '確認中...' : '署名して登録する'}
          </button>
        </div>
      )}

      {error && <p className="checkout-error">{error}</p>}
      {message && <p>{message}</p>}

      {confirming && (
        <div className="wallet-confirm-modal">
          <p>ウォレットアドレスを更新します。発行済みのNFTには影響しません。よろしいですか?</p>
          <button type="button" onClick={() => void doSign()}>
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
