import { useEffect, useRef, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import {
  deleteAdminProduct,
  deleteAdminProductVariant,
  fetchAdminProduct,
  updateAdminProduct,
  uploadAdminProductImage,
  type AdminProduct,
} from '../../lib/adminApi';
import {
  ITEM_TYPES,
  STATUSES,
  toTaxIncluded,
  toTaxExcludedEstimate,
  type PriceMode,
  type VariantRow,
} from '../../lib/productPricing';
import StatusBadge from '../../components/StatusBadge';

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
  const [status, setStatus] = useState('draft');
  const [basePrice, setBasePrice] = useState(0);
  const [priceMode, setPriceMode] = useState<PriceMode>('included');
  const [imagesText, setImagesText] = useState('');
  const [uploading, setUploading] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [statusMessage, setStatusMessage] = useState<StatusMessage | null>(null);
  const [newVariant, setNewVariant] = useState<VariantRow>({ name: '', stock: 0 });
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
        variants: [{ name: newVariant.name.trim(), price: product.basePrice, stock: newVariant.stock }],
      });
      notify('success', `「${newVariant.name.trim()}」を追加しました`);
      setNewVariant({ name: '', stock: 0 });
      load();
    } catch (e) {
      notify('error', e instanceof Error ? e.message : 'バリエーションの追加に失敗しました');
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
          <label>
            価格
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
        <h2 className="admin-form-section__title">この商品を削除</h2>
        <p className="admin-form-section__hint">注文実績がある商品は削除できません。非表示にしたい場合はステータスを「archived」にしてください。</p>
        <button type="button" className="btn-secondary btn-small" onClick={handleDeleteProduct}>
          商品を削除する
        </button>
      </div>
    </div>
  );
}
