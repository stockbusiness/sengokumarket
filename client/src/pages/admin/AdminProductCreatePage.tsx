import { useState } from 'react';
import { useNavigate, Link } from 'react-router-dom';
import { createAdminProduct, uploadAdminProductImage } from '../../lib/adminApi';
import {
  ITEM_TYPES,
  SALES_MODELS,
  SALES_MODEL_LABELS,
  DEFAULT_VARIANT_ROWS,
  toTaxIncluded,
  type PriceMode,
  type VariantRow,
} from '../../lib/productPricing';
import { AGENCY_ACCESS_MODES } from '@sengoku/contracts';

const AGENCY_ACCESS_MODE_LABEL: Record<string, string> = {
  none: '連携なし',
  customer_portal: '一般利用者としてログイン権限を付与',
  agent_portal: '代理店・アドバイザーとしてログイン権限を付与',
};

export default function AdminProductCreatePage() {
  const navigate = useNavigate();

  const [name, setName] = useState('');
  const [slug, setSlug] = useState('');
  const [description, setDescription] = useState('');
  const [category, setCategory] = useState('');
  const [itemType, setItemType] = useState('nft');
  const [salesModel, setSalesModel] = useState('hybrid');
  const [basePrice, setBasePrice] = useState(0);
  const [priceMode, setPriceMode] = useState<PriceMode>('included');
  const [variantRows, setVariantRows] = useState<VariantRow[]>(DEFAULT_VARIANT_ROWS);
  const [imagesText, setImagesText] = useState('');
  const [agencyAccessMode, setAgencyAccessMode] = useState('none');
  const [agencyRole, setAgencyRole] = useState('');
  const [agencyProductCode, setAgencyProductCode] = useState('');
  const [agencyAccessExpiresDays, setAgencyAccessExpiresDays] = useState('');
  const [agencyLoginRedirectPath, setAgencyLoginRedirectPath] = useState('');
  const [uploading, setUploading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  function parseImagesText(text: string): string[] {
    return text
      .split('\n')
      .map((line) => line.trim())
      .filter((line) => line.length > 0);
  }

  // 仕様書外の拡張: 価格(代表価格)を入力したら、まだ手動で価格を変更していないバリエーション行
  // (=DEFAULT_VARIANT_ROWSのまま、または直前のbasePriceと同額のまま)には自動で反映する。
  // 既に価格を個別に変更した行(basePriceと異なる値になっている行)は上書きしない。
  function handleBasePriceChange(value: number) {
    setVariantRows((prev) => prev.map((row) => (row.price === basePrice ? { ...row, price: value } : row)));
    setBasePrice(value);
  }

  function addVariantRow() {
    setVariantRows((prev) => [...prev, { name: '', stock: 0, price: basePrice }]);
  }

  function removeVariantRow(index: number) {
    setVariantRows((prev) => prev.filter((_, i) => i !== index));
  }

  function updateVariantRow(index: number, field: keyof VariantRow, value: string | number) {
    setVariantRows((prev) => prev.map((row, i) => (i === index ? { ...row, [field]: value } : row)));
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

  async function handleCreate(e: React.FormEvent) {
    e.preventDefault();
    setError(null);

    const validVariants = variantRows.filter((v) => v.name.trim());
    if (validVariants.length === 0) {
      setError('バリエーションを1つ以上入力してください(在庫が無いと購入できません)');
      return;
    }
    if (agencyAccessMode === 'agent_portal' && (!agencyRole.trim() || !agencyProductCode.trim())) {
      setError('代理店アカウント権限を付与する場合、役割コードと商品コードは必須です');
      return;
    }

    setSubmitting(true);
    try {
      const finalPrice = toTaxIncluded(basePrice, priceMode);
      await createAdminProduct({
        name,
        slug,
        description: description.trim() || null,
        category,
        itemType,
        salesModel,
        basePrice: finalPrice,
        status: 'draft',
        images: parseImagesText(imagesText),
        // バリエーションが1件だけの場合は価格入力欄を表示していないため(代表価格を使う設計)、
        // row.priceの値に依存せず必ずfinalPrice(代表価格)を送る。
        variants: validVariants.map((v) => ({
          name: v.name.trim(),
          price: validVariants.length === 1 ? finalPrice : toTaxIncluded(v.price, priceMode),
          stock: v.stock,
        })),
        agencyAccessMode,
        agencyRole: agencyRole.trim() || null,
        agencyProductCode: agencyProductCode.trim() || null,
        agencyAccessExpiresDays: agencyAccessExpiresDays.trim() ? Number(agencyAccessExpiresDays) : null,
        agencyLoginRedirectPath: agencyLoginRedirectPath.trim() || null,
      });
      navigate('/admin/products', { state: { message: `「${name}」を作成しました` } });
    } catch (e) {
      setError(e instanceof Error ? e.message : '作成に失敗しました');
      setSubmitting(false);
    }
  }

  return (
    <div>
      <h1>商品の新規登録</h1>
      <p>
        <Link to="/admin/products">← 商品一覧に戻る</Link>
      </p>

      <form onSubmit={handleCreate} className="admin-form-card admin-form-card--wide">
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
            slug(商品ページのURLに使われます。半角英数とハイフンのみ)
            <input type="text" value={slug} onChange={(e) => setSlug(e.target.value)} required />
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
        </div>

        <div className="admin-form-section">
          <h2 className="admin-form-section__title">価格(消費税10%)</h2>
          <p className="admin-form-section__hint">
            ここでの価格は一覧表示用の代表価格です。実際の販売価格はバリエーションごとに個別設定できます(下欄)。
          </p>
          <label>
            価格(代表価格)
            <input type="number" value={basePrice} onChange={(e) => handleBasePriceChange(Number(e.target.value))} required />
          </label>
          <div className="admin-tax-mode">
            <label>
              <input
                type="radio"
                name="price-mode-new"
                value="included"
                checked={priceMode === 'included'}
                onChange={() => setPriceMode('included')}
              />
              税込価格として入力
            </label>
            <label>
              <input
                type="radio"
                name="price-mode-new"
                value="excluded"
                checked={priceMode === 'excluded'}
                onChange={() => setPriceMode('excluded')}
              />
              税別価格として入力
            </label>
            {priceMode === 'excluded' && (
              <span className="admin-tax-mode__preview">
                → 税込 {toTaxIncluded(basePrice, 'excluded').toLocaleString()}円で登録されます
              </span>
            )}
          </div>
        </div>

        <div className="admin-form-section">
          <h2 className="admin-form-section__title">バリエーション・在庫</h2>
          <p className="admin-form-section__hint">
            色・サイズ等の選択肢ごとに、名前・価格・在庫数(個数)を入力してください。ここで在庫数を設定しないと購入できません。
            価格は上の「価格(代表価格)」欄と同じ税込/税別モードで入力してください。
            選択肢が無い商品は「通常」のまま在庫数(個数)だけ入力すれば大丈夫です。
          </p>
          {variantRows.map((row, index) => (
            <div className="admin-variant-row" key={index}>
              <label className="admin-variant-row__name">
                バリエーション名
                <input
                  type="text"
                  value={row.name}
                  placeholder="例: 通常、RED、Black"
                  onChange={(e) => updateVariantRow(index, 'name', e.target.value)}
                />
              </label>
              {variantRows.length === 1 ? (
                // 仕様書外の拡張: バリエーションが1件だけ(=実質バリエーション無し)の場合、価格を
                // 上の「価格(代表価格)」欄と別に入力させると、片方だけ入力して実売価格がずれる
                // 事故につながるため、ここでは価格入力自体を行わせず代表価格をそのまま使う。
                // 「+バリエーションを追加」で2件目以降を作った時点から、通常どおり個別に価格を
                // 入力できるようにする。
                <span className="admin-variant-row__price">価格 {basePrice.toLocaleString()}円(上の「価格(代表価格)」と同額)</span>
              ) : (
                <label className="admin-variant-row__price">
                  価格
                  <input
                    type="number"
                    value={row.price}
                    min={0}
                    onChange={(e) => updateVariantRow(index, 'price', Number(e.target.value))}
                  />
                </label>
              )}
              <label className="admin-variant-row__stock">
                在庫数
                <input
                  type="number"
                  value={row.stock}
                  min={0}
                  onChange={(e) => updateVariantRow(index, 'stock', Number(e.target.value))}
                />
              </label>
              {variantRows.length > 1 && (
                <button type="button" className="btn-secondary btn-small" onClick={() => removeVariantRow(index)}>
                  削除
                </button>
              )}
            </div>
          ))}
          <button type="button" className="btn-secondary btn-small" onClick={addVariantRow}>
            + バリエーションを追加
          </button>
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

        <div className="admin-form-section">
          <h2 className="admin-form-section__title">代理店ポータル連携</h2>
          <p className="admin-form-section__hint">
            この商品を購入した方に、代理店システムへのログイン権限を付与するかどうかの設定です。
            「代理店・アドバイザーとしてのログイン権限」を選んだ場合のみ、役割コードと商品コードの入力が必須になります。
          </p>
          <label>
            アクセス権限
            <select value={agencyAccessMode} onChange={(e) => setAgencyAccessMode(e.target.value)}>
              {AGENCY_ACCESS_MODES.map((mode) => (
                <option key={mode} value={mode}>
                  {AGENCY_ACCESS_MODE_LABEL[mode]}
                </option>
              ))}
            </select>
          </label>
          {agencyAccessMode === 'agent_portal' && (
            <>
              <label>
                役割コード(agencyRole・必須)
                <input type="text" value={agencyRole} onChange={(e) => setAgencyRole(e.target.value)} placeholder="例: participant" />
              </label>
              <label>
                代理店側の商品コード(agencyProductCode・必須)
                <input
                  type="text"
                  value={agencyProductCode}
                  onChange={(e) => setAgencyProductCode(e.target.value)}
                  placeholder="例: agency_entry_plan"
                />
              </label>
            </>
          )}
          {agencyAccessMode !== 'none' && (
            <>
              <label>
                アクセス有効日数(未入力の場合は無期限)
                <input
                  type="number"
                  min={1}
                  value={agencyAccessExpiresDays}
                  onChange={(e) => setAgencyAccessExpiresDays(e.target.value)}
                />
              </label>
              <label>
                ログイン後のリダイレクト先パス(任意)
                <input
                  type="text"
                  value={agencyLoginRedirectPath}
                  onChange={(e) => setAgencyLoginRedirectPath(e.target.value)}
                  placeholder="例: /dashboard"
                />
              </label>
            </>
          )}
        </div>

        {error && <p className="checkout-error">{error}</p>}
        <button type="submit" className="btn-primary" disabled={submitting}>
          {submitting ? '作成中...' : '作成する'}
        </button>
      </form>
    </div>
  );
}
