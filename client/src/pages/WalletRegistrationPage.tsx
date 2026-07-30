import { useEffect, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { confirmWalletRegistration, fetchWalletRegistrationStatus, requestWalletRegistrationNonce } from '../lib/api';

// window.ethereumの型定義はこのページでのみ必要な最小限のものに留める(新規依存追加を避けるため)。
interface InjectedProvider {
  request(args: { method: string; params?: unknown[] }): Promise<unknown>;
}

function getInjectedProvider(): InjectedProvider | null {
  const ethereum = (window as unknown as { ethereum?: InjectedProvider }).ethereum;
  return ethereum ?? null;
}

// 仕様書外の拡張: 管理画面から発行された「本人専用の登録用URL」からアクセスする、ログイン不要の
// ウォレット登録ページ。WalletPage.tsx(/mypage/wallet)と同じ接続→署名の2ステップだが、
// こちらは管理者発行のトークン(共通の受け皿ではなく、この購入者専用のURL)を使う。
export default function WalletRegistrationPage() {
  const [searchParams] = useSearchParams();
  const token = searchParams.get('token') ?? '';
  const [status, setStatus] = useState<'loading' | 'active' | 'used' | 'invalid'>('loading');
  const [connectedAddress, setConnectedAddress] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [connecting, setConnecting] = useState(false);
  const [signing, setSigning] = useState(false);

  useEffect(() => {
    if (!token) {
      setStatus('invalid');
      return;
    }
    fetchWalletRegistrationStatus(token)
      .then((d) => {
        if (d.status === 'active') setStatus('active');
        else if (d.status === 'used') setStatus('used');
        else setStatus('invalid');
      })
      .catch(() => setStatus('invalid'));
  }, [token]);

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

  async function handleSign() {
    if (!connectedAddress) return;
    const provider = getInjectedProvider();
    if (!provider) {
      setError('対応するウォレット拡張機能が見つかりません');
      return;
    }
    setError(null);
    setSigning(true);
    try {
      const { message: challengeMessage } = await requestWalletRegistrationNonce(token, connectedAddress);
      const signature = (await provider.request({
        method: 'personal_sign',
        params: [challengeMessage, connectedAddress],
      })) as string;
      await confirmWalletRegistration(token, connectedAddress, signature);
      setStatus('used');
      setMessage('受取用ウォレットを確認・登録しました。');
    } catch (e) {
      setError(e instanceof Error ? e.message : '署名または登録に失敗しました');
    } finally {
      setSigning(false);
    }
  }

  if (status === 'loading') {
    return <p>確認しています...</p>;
  }

  if (status === 'invalid') {
    return <p>このリンクは無効または期限切れです。お手数ですが、案内元へ再発行をご依頼ください。</p>;
  }

  if (status === 'used') {
    return <p>{message ?? 'このリンクは既に登録済みです。'}</p>;
  }

  return (
    <div className="checkout-page">
      <h1>受取用ウォレットの登録</h1>
      <p>デジタル会員証(NFT)の受け取りに使用するウォレットを接続し、ご本人であることを確認(署名)してください。</p>

      {!connectedAddress ? (
        <button type="button" className="btn-primary" onClick={() => void handleConnect()} disabled={connecting}>
          {connecting ? '接続中...' : 'ウォレットに接続する'}
        </button>
      ) : (
        <div>
          <p>接続中のアドレス: {connectedAddress}</p>
          <button type="button" className="btn-primary" onClick={() => void handleSign()} disabled={signing}>
            {signing ? '確認中...' : '署名して登録する'}
          </button>
        </div>
      )}

      {error && <p className="checkout-error">{error}</p>}
    </div>
  );
}
