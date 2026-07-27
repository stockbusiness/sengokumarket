// 本番安定化指示書Stage12(15.3「追加」: critical E2E・「Feature Flag false検証」)。
// dist/index.js から実際に起動したサーバーへ対して、購入者が最初に触る導線
// (商品一覧 → 会員登録 → ログイン → 自分の情報取得)が最低限動くことと、
// SENNOKUNI_INTEGRATION_ENABLED未設定(既定false)であることを本番相当のビルド成果物で確認する。
// フルブラウザE2E(Playwright)ではなく、CIの実行時間を抑えるためAPIレベルの確認にとどめる。

const BASE_URL = process.env.CI_SMOKE_BASE_URL ?? 'http://localhost:4000';
// requireSameOrigin(CSRF対策)がAPP_URLと一致するOriginヘッダーを要求するため、APIサーバー
// 自身のURLではなくAPP_URL(フロントのオリジン)を使う。
const ORIGIN = process.env.APP_URL ?? 'http://localhost:5173';

async function expectOk(path, init) {
  const res = await fetch(`${BASE_URL}${path}`, init);
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`${init?.method ?? 'GET'} ${path} failed: ${res.status} ${body}`);
  }
  return res;
}

async function main() {
  // このカートは代理店の紹介URL経由(またはログイン後)以外は商品情報を公開しない運用のため
  // (middleware/referralAccess.ts)、匿名のまま/api/productsへは到達できない。まず会員登録して
  // 認証Cookieを得たうえで確認する。
  const email = `ci-critical-smoke-${Date.now()}@example.com`;
  const registerRes = await expectOk('/api/auth/register', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Origin: ORIGIN },
    body: JSON.stringify({ name: 'CI Smoke', email, password: 'password123' }),
  });
  const cookie = registerRes.headers.get('set-cookie');
  if (!cookie) throw new Error('register did not set an auth cookie');

  const meRes = await expectOk('/api/auth/me', { headers: { Cookie: cookie } });
  const me = await meRes.json();
  if (me.user?.email !== email) throw new Error('me endpoint did not return the registered user');

  await expectOk('/api/products', { headers: { Cookie: cookie } });

  // 15.3「Feature Flag false検証」: このワークフローはSENNOKUNI_INTEGRATION_ENABLEDを
  // 一切設定しないため、本番ビルド成果物でも無効のままであることを直接確認する
  // (既定値がtrueへ誤って変わっても検知できるように、値そのものを表示・比較する)。
  // /api/readyはenv/migration不備時に503を返す設計のため、ステータスに関わらず本文で判定する。
  const readyRes = await fetch(`${BASE_URL}/api/ready`);
  const ready = await readyRes.json();
  if (ready.integrationEnabled !== false) {
    throw new Error(`integrationEnabled should be false by default, got: ${JSON.stringify(ready.integrationEnabled)}`);
  }

  console.log('critical path smoke test passed (products / register / me / integrationEnabled=false)');
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
