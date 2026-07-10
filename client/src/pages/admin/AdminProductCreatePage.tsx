import { useState } from 'react';
import { useNavigate, Link } from 'react-router-dom';
import { createAdminProduct, uploadAdminProductImage } from '../../lib/adminApi';
import {
  ITEM_TYPES,
  DEFAULT_VARIANT_ROWS,
  toTaxIncluded,
  type PriceMode,
  type VariantRow,
} from '../../lib/productPricing';

export default function AdminProductCreatePage() {
  const navigate = useNavigate();

  const [name, setName] = useState('');
  const [slug, setSlug] = useState('');
  const [description, setDescription] = useState('');
  const [category, setCategory] = useState('');
  const [itemType, setItemType] = useState('nft');
  const [basePrice, setBasePrice] = useState(0);
  const [priceMode, setPriceMode] = useState<PriceMode>('included');
  const [variantRows, setVariantRows] = useState<VariantRow[]>(DEFAULT_VARIANT_ROWS);
  const [imagesText, setImagesText] = useState('');
  const [uploading, setUploading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  function parseImagesText(text: string): string[] {
    return text
      .split('\n')
      .map((line) => line.trim())
      .filter((line) => line.length > 0);
  }

  function addVariantRow() {
    setVariantRows((prev) => [...prev, { name: '', stock: 0 }]);
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

    setSubmitting(true);
    try {
      const finalPrice = toTaxIncluded(basePrice, priceMode);
      await createAdminProduct({
        name,
        slug,
        description: description.trim() || null,
        category,
        itemType,
        basePrice: finalPrice,
        status: 'draft',
        images: parseImagesText(imagesText),
        variants: validVariants.map((v) => ({ name: v.name.trim(), price: finalPrice, stock: v.stock })),
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
        </div>

        <div className="admin-form-section">
          <h2 className="admin-form-section__title">価格(消費税10%)</h2>
          <label>
            価格
            <input type="number" value={basePrice} onChange={(e) => setBasePrice(Number(e.target.value))} required />
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
            色・サイズ等の選択肢ごとに、名前と在庫数(個数)を入力してください。ここで在庫数を設定しないと購入できません。
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

        {error && <p className="checkout-error">{error}</p>}
        <button type="submit" className="btn-primary" disabled={submitting}>
          {submitting ? '作成中...' : '作成する'}
        </button>
      </form>
    </div>
  );
}
