import { useEffect, useRef, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import {
  createAdminProductIntegrationRule,
  deleteAdminProduct,
  deleteAdminProductVariant,
  fetchAdminProduct,
  updateAdminProduct,
  updateAdminProductIntegrationRule,
  uploadAdminProductImage,
  type AdminProduct,
  type AdminProductIntegrationRule,
  type IntegrationRuleRequest,
} from '../../lib/adminApi';
import {
  ITEM_TYPES,
  SALES_MODELS,
  SALES_MODEL_LABELS,
  STATUSES,
  toTaxIncluded,
  toTaxExcludedEstimate,
  type PriceMode,
  type VariantRow,
} from '../../lib/productPricing';
import { ENTITLEMENT_TARGET_SYSTEM_KEYS, REWARD_CALCULATION_MODES } from '@sengoku/contracts';
import StatusBadge from '../../components/StatusBadge';

const EMPTY_RULE_FORM: IntegrationRuleRequest = {
  entitlementTargetSystemKey: '',
  entitlementType: '',
  productCode: '',
  rewardRuleId: '',
  rewardAmountPerUnit: null,
  rewardCalculationMode: '',
  revokeOnRefund: true,
  requireCommonUserId: false,
  requireSalesAgentId: false,
  requireClosingAgentId: false,
  requireReferralSessionKey: false,
  assetCode: '',
  collectibleRarity: '',
};

type StatusMessage = { type: 'success' | 'error'; text: string };

export default function AdminProductEditPage() {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();

  const [product, setProduct] = useState<AdminProduct | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);

  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [category, setCategory] = useState('');
  const [itemType, setItemType] = useState('nft');
  const [salesModel, setSalesModel] = useState('hybrid');
  const [status, setStatus] = useState('draft');
  const [basePrice, setBasePrice] = useState(0);
  const [priceMode, setPriceMode] = useState<PriceMode>('included');
  const [imagesText, setImagesText] = useState('');
  const [uploading, setUploading] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [statusMessage, setStatusMessage] = useState<StatusMessage | null>(null);
  const [newVariant, setNewVariant] = useState<VariantRow>({ name: '', stock: 0, price: 0 });
  const [newRule, setNewRule] = useState<IntegrationRuleRequest>(EMPTY_RULE_FORM);
  const [ruleSubmitting, setRuleSubmitting] = useState(false);
  const priceInputRef = useRef<HTMLInputElement | null>(null);

  function load() {
    if (!id) return;
    setLoading(true);
    fetchAdminProduct(id)
      .then((d) => {
        setProduct(d.product);
        setName(d.product.name);
        setDescription(d.product.description ?? '');
        setCategory(d.product.category);
        setItemType(d.product.itemType);
        setSalesModel(d.product.salesModel);
        setStatus(d.product.status);
        setBasePrice(d.product.basePrice);
        setPriceMode('included');
        setImagesText(d.product.images.join('\n'));
      })
      .catch((e) => setLoadError(e instanceof Error ? e.message : '読み込みに失敗しました'))
      .finally(() => setLoading(false));
  }

  useEffect(load, [id]);

  function notify(type: StatusMessage['type'], text: string) {
    setStatusMessage({ type, text });
    setTimeout(() => setStatusMessage((cur) => (cur?.text === text ? null : cur)), 4000);
  }

  function parseImagesText(text: string): string[] {
    return text
      .split('\n')
      .map((line) => line.trim())
      .filter((line) => line.length > 0);
  }

  // 税込/税別モードを切り替えた際、入力欄の表示をそのモードに合わせて作り直す
  // (税込表示中の数値をそのまま税別金額として送信してしまう事故を防ぐ)。
  function handlePriceModeChange(mode: PriceMode) {
    setPriceMode(mode);
    if (!product) return;
    setBasePrice(mode === 'excluded' ? toTaxExcludedEstimate(product.basePrice) : product.basePrice);
  }

  async function handleUpload(files: FileList | null) {
    if (!files || files.length === 0) return;
    setUploading(true);
    try {
      for (const file of Array.from(files)) {
        const { url } = await uploadAdminProductImage(file);
        setImagesText((prev) => (prev.trim() ? `${prev}\n${url}` : url));
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : '画像のアップロードに失敗しました');
    } finally {
      setUploading(false);
    }
  }

  async function handleSave(e: React.FormEvent) {
    e.preventDefault();
    if (!product) return;
    setError(null);
    setSubmitting(true);
    try {
      const finalPrice = toTaxIncluded(basePrice, priceMode);
      await updateAdminProduct(product.id, {
        name,
        description: description.trim() || null,
        category,
        itemType,
        salesModel,
        status,
        basePrice: finalPrice,
        images: parseImagesText(imagesText),
      });
      notify('success', '変更を保存しました');
      load();
    } catch (e) {
      setError(e instanceof Error ? e.message : '保存に失敗しました');
    } finally {
      setSubmitting(false);
    }
  }

  async function handleUpdateStock(variantId: string, variantName: string, stock: number) {
    if (!product) return;
    try {
      await updateAdminProduct(product.id, { variants: [{ id: variantId, stock }] });
      notify('success', `${variantName}の在庫数を更新しました`);
      load();
    } catch (e) {
      notify('error', e instanceof Error ? e.message : '在庫数の更新に失敗しました');
    }
  }

  // 残課題指示書第15章: basePriceは代表価格に過ぎず、実際の販売価格はバリエーションごとに
  // 個別管理する(basePrice変更によるバリエーション価格の一括上書きは廃止した)。
  async function handleUpdateVariantPrice(variantId: string, variantName: string, price: number) {
    if (!product) return;
    try {
      await updateAdminProduct(product.id, { variants: [{ id: variantId, price }] });
      notify('success', `${variantName}の価格を更新しました`);
      load();
    } catch (e) {
      notify('error', e instanceof Error ? e.message : '価格の更新に失敗しました');
    }
  }

  async function handleDeleteVariant(variantId: string, variantName: string) {
    if (!product) return;
    if (!window.confirm(`「${variantName}」を削除します。よろしいですか？`)) return;
    try {
      await deleteAdminProductVariant(product.id, variantId);
      notify('success', `「${variantName}」を削除しました`);
      load();
    } catch (e) {
      notify('error', e instanceof Error ? e.message : 'バリエーションの削除に失敗しました');
    }
  }

  async function handleAddVariant() {
    if (!product) return;
    if (!newVariant.name.trim()) {
      notify('error', 'バリエーション名を入力してください');
      return;
    }
    try {
      await updateAdminProduct(product.id, {
        variants: [{ name: newVariant.name.trim(), price: newVariant.price, stock: newVariant.stock }],
      });
      notify('success', `「${newVariant.name.trim()}」を追加しました`);
      setNewVariant({ name: '', stock: 0, price: 0 });
      load();
    } catch (e) {
      notify('error', e instanceof Error ? e.message : 'バリエーションの追加に失敗しました');
    }
  }

  // 本番安定化指示書Stage6(9.5): 商品ごとの権利付与ルーティング設定(連携ルール)の追加・更新。
  // 1商品から複数の送信先へ設定できる(1:N化)ため、削除ではなく有効/無効(enabled)の
  // 切り替えで一時停止する運用にする(既存のNFT発行と同様、外部連携は一度送ると取り消せない
  // 操作を含むため、行の物理削除は用意しない)。
  function normalizeRulePayload(input: IntegrationRuleRequest): IntegrationRuleRequest {
    return {
      ...input,
      entitlementTargetSystemKey: input.entitlementTargetSystemKey?.trim() || null,
      entitlementType: input.entitlementType?.trim() || null,
      productCode: input.productCode?.trim() || null,
      rewardRuleId: input.rewardRuleId?.trim() || null,
      rewardCalculationMode: input.rewardCalculationMode?.trim() || null,
      assetCode: input.assetCode?.trim() || null,
      collectibleRarity: input.collectibleRarity?.trim() || null,
    };
  }

  async function handleAddRule() {
    if (!product) return;
    if (!newRule.entitlementTargetSystemKey) {
      notify('error', '送信先を選択してください');
      return;
    }
    setRuleSubmitting(true);
    try {
      await createAdminProductIntegrationRule(product.id, normalizeRulePayload(newRule));
      notify('success', '連携ルールを追加しました');
      setNewRule(EMPTY_RULE_FORM);
      load();
    } catch (e) {
      notify('error', e instanceof Error ? e.message : '連携ルールの追加に失敗しました');
    } finally {
      setRuleSubmitting(false);
    }
  }

  async function handleUpdateRule(rule: AdminProductIntegrationRule, patch: IntegrationRuleRequest) {
    if (!product) return;
    try {
      await updateAdminProductIntegrationRule(product.id, rule.id, patch);
      notify('success', '連携ルールを更新しました');
      load();
    } catch (e) {
      notify('error', e instanceof Error ? e.message : '連携ルールの更新に失敗しました');
    }
  }

  async function handleDeleteProduct() {
    if (!product) return;
    if (!window.confirm(`「${product.name}」を削除します。よろしいですか？(元に戻せません)`)) return;
    try {
      await deleteAdminProduct(product.id);
      navigate('/admin/products', { state: { message: `「${product.name}」を削除しました` } });
    } catch (e) {
      notify('error', e instanceof Error ? e.message : '削除に失敗しました');
    }
  }

  if (loading) return <p>読み込み中です...</p>;
  if (loadError) return <p className="checkout-error">読み込みに失敗しました: {loadError}</p>;
  if (!product) return null;

  return (
    <div>
      <h1>商品の編集</h1>
      <p>
        <Link to="/admin/products">← 商品一覧に戻る</Link>
      </p>

      {statusMessage && (
        <p className={statusMessage.type === 'error' ? 'checkout-error' : 'admin-status-success'}>{statusMessage.text}</p>
      )}

      <form onSubmit={handleSave} className="admin-form-card admin-form-card--wide">
        <div className="admin-form-section">
          <h2 className="admin-form-section__title">基本情報</h2>
          <label>
            商品名
            <input type="text" value={name} onChange={(e) => setName(e.target.value)} required />
          </label>
          <label>
            商品説明(商品ページに表示されます。改行もそのまま反映されます)
            <textarea
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              rows={4}
              placeholder="商品の魅力や特典の内容などを入力してください"
            />
          </label>
          <label>
            slug(商品ページのURLに使われています。既存の紹介URL等が壊れるため変更できません)
            <input type="text" value={product.slug} disabled />
          </label>
          <label>
            カテゴリ
            <input type="text" value={category} onChange={(e) => setCategory(e.target.value)} required />
          </label>
          <label>
            商品タイプ
            <select value={itemType} onChange={(e) => setItemType(e.target.value)}>
              {ITEM_TYPES.map((t) => (
                <option key={t} value={t}>
                  {t}
                </option>
              ))}
            </select>
          </label>
          <label>
            販売方式
            <select value={salesModel} onChange={(e) => setSalesModel(e.target.value)}>
              {SALES_MODELS.map((m) => (
                <option key={m} value={m}>
                  {SALES_MODEL_LABELS[m]}
                </option>
              ))}
            </select>
          </label>
          <label>
            ステータス <StatusBadge status={status} />
            <select value={status} onChange={(e) => setStatus(e.target.value)}>
              {STATUSES.map((s) => (
                <option key={s} value={s}>
                  {s}
                </option>
              ))}
            </select>
          </label>
        </div>

        <div className="admin-form-section">
          <h2 className="admin-form-section__title">価格(消費税10%)</h2>
          <p className="admin-form-section__hint">
            ここでの価格は一覧表示用の代表価格です。実際の販売価格はバリエーションごとに個別設定します(下欄)。
          </p>
          <label>
            価格(代表価格)
            <input
              type="number"
              ref={priceInputRef}
              value={basePrice}
              onChange={(e) => setBasePrice(Number(e.target.value))}
              required
            />
          </label>
          <div className="admin-tax-mode">
            <label>
              <input
                type="radio"
                name="price-mode-edit"
                value="included"
                checked={priceMode === 'included'}
                onChange={() => handlePriceModeChange('included')}
              />
              税込価格として入力
            </label>
            <label>
              <input
                type="radio"
                name="price-mode-edit"
                value="excluded"
                checked={priceMode === 'excluded'}
                onChange={() => handlePriceModeChange('excluded')}
              />
              税別価格として入力
            </label>
            {priceMode === 'excluded' && (
              <span className="admin-tax-mode__preview">
                → 税込 {toTaxIncluded(basePrice, 'excluded').toLocaleString()}円で保存されます
              </span>
            )}
          </div>
        </div>

        <div className="admin-form-section">
          <h2 className="admin-form-section__title">商品画像</h2>
          <label>
            画像を選択してアップロード(先頭が一覧・共有時のサムネイルになります)
            <input
              type="file"
              accept="image/png,image/jpeg,image/webp,image/gif"
              multiple
              disabled={uploading}
              onChange={(e) => handleUpload(e.target.files)}
            />
          </label>
          {uploading && <p>アップロード中です...</p>}
          <label>
            商品画像URL(アップロード済みの画像が自動で入ります。外部URLを直接指定することもできます)
            <textarea
              value={imagesText}
              onChange={(e) => setImagesText(e.target.value)}
              rows={3}
              placeholder={'https://example.com/image1.jpg\nhttps://example.com/image2.jpg'}
            />
          </label>
        </div>

        {error && <p className="checkout-error">{error}</p>}
        <button type="submit" className="btn-primary" disabled={submitting}>
          {submitting ? '保存中...' : '変更を保存する'}
        </button>
      </form>

      <div className="admin-form-card admin-form-card--wide">
        <h2 className="admin-form-section__title">バリエーション・在庫</h2>
        {product.variants.length === 0 && (
          <p className="checkout-error">バリエーションが無く購入できません。下から追加してください。</p>
        )}
        {product.variants.map((v) => (
          <div className="admin-variant-row" key={v.id}>
            <span className="admin-variant-row__name">{v.name}</span>
            <label className="admin-variant-row__price">
              価格
              <input
                type="number"
                min={0}
                defaultValue={v.price}
                onBlur={(e) => {
                  const next = Number(e.target.value);
                  if (next !== v.price) handleUpdateVariantPrice(v.id, v.name, next);
                }}
              />
            </label>
            <label className="admin-variant-row__stock">
              在庫数
              <input
                type="number"
                defaultValue={v.stock}
                onBlur={(e) => {
                  const next = Number(e.target.value);
                  if (next !== v.stock) handleUpdateStock(v.id, v.name, next);
                }}
              />
            </label>
            <button type="button" className="btn-secondary btn-small" onClick={() => handleDeleteVariant(v.id, v.name)}>
              削除
            </button>
          </div>
        ))}
        <div className="admin-variant-row">
          <label className="admin-variant-row__name">
            バリエーション名
            <input
              type="text"
              placeholder="例: 通常、RED、Black"
              value={newVariant.name}
              onChange={(e) => setNewVariant((prev) => ({ ...prev, name: e.target.value }))}
            />
          </label>
          <label className="admin-variant-row__price">
            価格
            <input
              type="number"
              min={0}
              value={newVariant.price}
              onChange={(e) => setNewVariant((prev) => ({ ...prev, price: Number(e.target.value) }))}
            />
          </label>
          <label className="admin-variant-row__stock">
            在庫数
            <input
              type="number"
              min={0}
              value={newVariant.stock}
              onChange={(e) => setNewVariant((prev) => ({ ...prev, stock: Number(e.target.value) }))}
            />
          </label>
          <button type="button" className="btn-secondary btn-small" onClick={handleAddVariant}>
            追加
          </button>
        </div>
      </div>

      <div className="admin-form-card admin-form-card--wide">
        <h2 className="admin-form-section__title">連携ルール(千ノ国連携)</h2>
        <p className="admin-form-section__hint">
          この商品を購入した際に、外部システムへ権利(パスポート・AIアート教室受講権・OVEポイント等)を送信する設定です。
          1商品につき複数の送信先を設定できます。まだ連携は本番で有効化されていません(設定しても実際には送信されません)。
        </p>
        {(product.integrationRules ?? []).map((rule) => (
          <div className="admin-variant-row" key={rule.id}>
            <span className="admin-variant-row__name">
              {rule.entitlementTargetSystemKey ?? '(未設定)'}
              {rule.entitlementType ? ` / ${rule.entitlementType}` : ''}
              {!rule.enabled && <span className="status-badge status-badge--muted">無効</span>}
            </span>
            {rule.entitlementTargetSystemKey === 'ove-wallet' && rule.entitlementType !== 'digital_collectible' && (
              <>
                <label className="admin-variant-row__price">
                  1個当たりポイント
                  <input
                    type="number"
                    min={0}
                    defaultValue={rule.rewardAmountPerUnit ?? 0}
                    onBlur={(e) => {
                      const next = Number(e.target.value);
                      if (next !== (rule.rewardAmountPerUnit ?? 0)) handleUpdateRule(rule, { rewardAmountPerUnit: next });
                    }}
                  />
                </label>
                <label className="admin-variant-row__stock">
                  計算方式
                  <select
                    defaultValue={rule.rewardCalculationMode ?? ''}
                    onChange={(e) => handleUpdateRule(rule, { rewardCalculationMode: e.target.value || null })}
                  >
                    <option value="">(未設定)</option>
                    {REWARD_CALCULATION_MODES.map((m) => (
                      <option key={m} value={m}>
                        {m}
                      </option>
                    ))}
                  </select>
                </label>
              </>
            )}
            {rule.entitlementType === 'digital_collectible' && (
              <>
                <label className="admin-variant-row__price">
                  asset code(必須)
                  <input
                    type="text"
                    defaultValue={rule.assetCode ?? ''}
                    onBlur={(e) => {
                      const next = e.target.value.trim() || null;
                      if (next !== rule.assetCode) handleUpdateRule(rule, { assetCode: next });
                    }}
                  />
                </label>
                <label className="admin-variant-row__stock">
                  レアリティ
                  <input
                    type="text"
                    defaultValue={rule.collectibleRarity ?? ''}
                    onBlur={(e) => {
                      const next = e.target.value.trim() || null;
                      if (next !== rule.collectibleRarity) handleUpdateRule(rule, { collectibleRarity: next });
                    }}
                  />
                </label>
                <label>
                  common_user_id必須
                  <input
                    type="checkbox"
                    checked={rule.requireCommonUserId}
                    onChange={(e) => handleUpdateRule(rule, { requireCommonUserId: e.target.checked })}
                  />
                </label>
              </>
            )}
            <label>
              返金時に取消
              <input
                type="checkbox"
                checked={rule.revokeOnRefund}
                onChange={(e) => handleUpdateRule(rule, { revokeOnRefund: e.target.checked })}
              />
            </label>
            <button
              type="button"
              className="btn-secondary btn-small"
              onClick={() => handleUpdateRule(rule, { enabled: !rule.enabled })}
            >
              {rule.enabled ? '無効化する' : '有効化する'}
            </button>
          </div>
        ))}

        <div className="admin-variant-row">
          <label className="admin-variant-row__name">
            送信先
            <select
              value={newRule.entitlementTargetSystemKey ?? ''}
              onChange={(e) => setNewRule((prev) => ({ ...prev, entitlementTargetSystemKey: e.target.value }))}
            >
              <option value="">選択してください</option>
              {ENTITLEMENT_TARGET_SYSTEM_KEYS.map((k) => (
                <option key={k} value={k}>
                  {k}
                </option>
              ))}
            </select>
          </label>
          <label className="admin-variant-row__price">
            entitlement type
            <input
              type="text"
              placeholder="例: castle_lord_contract"
              value={newRule.entitlementType ?? ''}
              onChange={(e) => setNewRule((prev) => ({ ...prev, entitlementType: e.target.value }))}
            />
          </label>
          <label className="admin-variant-row__stock">
            product code
            <input
              type="text"
              value={newRule.productCode ?? ''}
              onChange={(e) => setNewRule((prev) => ({ ...prev, productCode: e.target.value }))}
            />
          </label>
          {newRule.entitlementTargetSystemKey === 'ove-wallet' && newRule.entitlementType !== 'digital_collectible' && (
            <>
              <label className="admin-variant-row__price">
                1個当たりポイント
                <input
                  type="number"
                  min={0}
                  value={newRule.rewardAmountPerUnit ?? 0}
                  onChange={(e) => setNewRule((prev) => ({ ...prev, rewardAmountPerUnit: Number(e.target.value) }))}
                />
              </label>
              <label className="admin-variant-row__stock">
                計算方式
                <select
                  value={newRule.rewardCalculationMode ?? ''}
                  onChange={(e) => setNewRule((prev) => ({ ...prev, rewardCalculationMode: e.target.value }))}
                >
                  <option value="">(未設定)</option>
                  {REWARD_CALCULATION_MODES.map((m) => (
                    <option key={m} value={m}>
                      {m}
                    </option>
                  ))}
                </select>
              </label>
              <label className="admin-variant-row__price">
                OVE reward rule ID
                <input
                  type="text"
                  value={newRule.rewardRuleId ?? ''}
                  onChange={(e) => setNewRule((prev) => ({ ...prev, rewardRuleId: e.target.value }))}
                />
              </label>
            </>
          )}
          {newRule.entitlementType === 'digital_collectible' && (
            <>
              <label className="admin-variant-row__price">
                asset code(必須)
                <input
                  type="text"
                  value={newRule.assetCode ?? ''}
                  onChange={(e) => setNewRule((prev) => ({ ...prev, assetCode: e.target.value }))}
                />
              </label>
              <label className="admin-variant-row__stock">
                レアリティ
                <input
                  type="text"
                  value={newRule.collectibleRarity ?? ''}
                  onChange={(e) => setNewRule((prev) => ({ ...prev, collectibleRarity: e.target.value }))}
                />
              </label>
              <label>
                common_user_id必須
                <input
                  type="checkbox"
                  checked={newRule.requireCommonUserId ?? false}
                  onChange={(e) => setNewRule((prev) => ({ ...prev, requireCommonUserId: e.target.checked }))}
                />
              </label>
            </>
          )}
          <button type="button" className="btn-secondary btn-small" disabled={ruleSubmitting} onClick={handleAddRule}>
            追加
          </button>
        </div>
      </div>

      <div className="admin-form-card admin-form-card--wide">
        <h2 className="admin-form-section__title">この商品を削除</h2>
        <p className="admin-form-section__hint">注文実績がある商品は削除できません。非表示にしたい場合はステータスを「archived」にしてください。</p>
        <button type="button" className="btn-secondary btn-small" onClick={handleDeleteProduct}>
          商品を削除する
        </button>
      </div>
    </div>
  );
}
