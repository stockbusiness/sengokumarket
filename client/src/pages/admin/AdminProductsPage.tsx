import { useEffect, useRef, useState } from 'react';
import {
  createAdminProduct,
  deleteAdminProduct,
  fetchAdminProducts,
  updateAdminProduct,
  uploadAdminProductImage,
  type AdminProduct,
} from '../../lib/adminApi';
import StatusBadge from '../../components/StatusBadge';
import EmptyState from '../../components/EmptyState';

const ITEM_TYPES = ['nft', 'physical', 'service', 'membership', 'fee'];
const STATUSES = ['draft', 'published', 'archived'];
// 仕様書外の拡張: 価格入力を税込/税別のどちらでも受け付けられるようにする。
// 保存される金額(basePrice/variant.price)は常に実際の決済金額(税込)であり、
// この変換はあくまで入力時の利便性のためのもの(仕様書v1.5 コーディング規約「金額は
// すべてINTEGER(円)」を維持し、税別入力時は税込金額に変換してから送信する)。
const TAX_RATE = 0.1;
type PriceMode = 'included' | 'excluded';

function toTaxIncluded(amount: number, mode: PriceMode): number {
  return mode === 'excluded' ? Math.floor(amount * (1 + TAX_RATE)) : amount;
}

// 税込価格から税別価格の目安を逆算する(モード切替時に入力欄の表示を作り直すためだけに使う。
// 保存処理では使わない)。
function toTaxExcludedEstimate(amount: number): number {
  return Math.round(amount / (1 + TAX_RATE));
}

type StatusMessage = { type: 'success' | 'error'; text: string };

export default function AdminProductsPage() {
  const [products, setProducts] = useState<AdminProduct[]>([]);
  const [showForm, setShowForm] = useState(false);
  const [name, setName] = useState('');
  const [slug, setSlug] = useState('');
  const [category, setCategory] = useState('');
  const [itemType, setItemType] = useState('nft');
  const [basePrice, setBasePrice] = useState(0);
  const [priceMode, setPriceMode] = useState<PriceMode>('included');
  const [rowPriceMode, setRowPriceMode] = useState<Record<string, PriceMode>>({});
  const [imagesText, setImagesText] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [uploadingNew, setUploadingNew] = useState(false);
  const [uploadingRowId, setUploadingRowId] = useState<string | null>(null);
  const [statusMessage, setStatusMessage] = useState<StatusMessage | null>(null);
  const imagesTextareaRefs = useRef<Record<string, HTMLTextAreaElement | null>>({});
  const priceInputRefs = useRef<Record<string, HTMLInputElement | null>>({});
  // モード切替時に自動で書き換えた表示値を覚えておき、そこから実際に編集されていなければ
  // (=単に選択欄を切り替えてフォーカスが外れただけなら)保存自体をスキップする。
  const priceAutoSetValueRefs = useRef<Record<string, string>>({});

  function parseImagesText(text: string): string[] {
    return text
      .split('\n')
      .map((line) => line.trim())
      .filter((line) => line.length > 0);
  }

  function load() {
    fetchAdminProducts().then((d) => setProducts(d.products));
  }

  useEffect(load, []);

  // 保存の成否がその場で分かるよう、一定時間で自動的に消える通知を出す
  // (これまでインライン編集の保存はサイレントで、失敗しても何も表示されなかった)。
  function notify(type: StatusMessage['type'], text: string) {
    setStatusMessage({ type, text });
    setTimeout(() => setStatusMessage((cur) => (cur?.text === text ? null : cur)), 4000);
  }

  async function handleCreate(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    try {
      await createAdminProduct({
        name,
        slug,
        category,
        itemType,
        basePrice: toTaxIncluded(basePrice, priceMode),
        status: 'draft',
        images: parseImagesText(imagesText),
      });
      setName('');
      setSlug('');
      setCategory('');
      setBasePrice(0);
      setPriceMode('included');
      setImagesText('');
      setShowForm(false);
      load();
    } catch (e) {
      setError(e instanceof Error ? e.message : '作成に失敗しました');
    }
  }

  async function handleUploadForNewProduct(files: FileList | null) {
    if (!files || files.length === 0) return;
    setUploadingNew(true);
    try {
      for (const file of Array.from(files)) {
        const { url } = await uploadAdminProductImage(file);
        setImagesText((prev) => (prev.trim() ? `${prev}\n${url}` : url));
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : '画像のアップロードに失敗しました');
    } finally {
      setUploadingNew(false);
    }
  }

  async function updateStatus(product: AdminProduct, status: string) {
    try {
      await updateAdminProduct(product.id, { status });
      notify('success', `「${product.name}」のステータスを更新しました`);
      load();
    } catch (e) {
      notify('error', e instanceof Error ? e.message : 'ステータスの更新に失敗しました');
    }
  }

  async function updateField(product: AdminProduct, field: 'name' | 'category' | 'itemType' | 'basePrice', value: string | number) {
    try {
      await updateAdminProduct(product.id, { [field]: value });
      notify('success', `「${product.name}」を更新しました`);
      load();
    } catch (e) {
      notify('error', e instanceof Error ? e.message : '更新に失敗しました');
    }
  }

  async function handleDelete(product: AdminProduct) {
    if (!window.confirm(`「${product.name}」を削除します。よろしいですか？(元に戻せません)`)) return;
    try {
      await deleteAdminProduct(product.id);
      notify('success', `「${product.name}」を削除しました`);
      load();
    } catch (e) {
      notify('error', e instanceof Error ? e.message : '削除に失敗しました');
    }
  }

  async function updateStock(product: AdminProduct, variantId: string, variantName: string, stock: number) {
    try {
      await updateAdminProduct(product.id, { variants: [{ id: variantId, stock }] });
      notify('success', `「${product.name}」の${variantName}の在庫数を更新しました`);
      load();
    } catch (e) {
      notify('error', e instanceof Error ? e.message : '在庫数の更新に失敗しました');
    }
  }

  async function updateImages(product: AdminProduct, text: string) {
    try {
      await updateAdminProduct(product.id, { images: parseImagesText(text) });
      notify('success', `「${product.name}」の商品画像を更新しました`);
      load();
    } catch (e) {
      notify('error', e instanceof Error ? e.message : '商品画像の更新に失敗しました');
    }
  }

  async function handleUploadForRow(product: AdminProduct, files: FileList | null) {
    if (!files || files.length === 0) return;
    setUploadingRowId(product.id);
    try {
      const textarea = imagesTextareaRefs.current[product.id];
      let current = textarea?.value ?? product.images.join('\n');
      for (const file of Array.from(files)) {
        const { url } = await uploadAdminProductImage(file);
        current = current.trim() ? `${current}\n${url}` : url;
      }
      if (textarea) textarea.value = current;
      await updateImages(product, current);
    } catch (e) {
      notify('error', e instanceof Error ? e.message : '画像のアップロードに失敗しました');
    } finally {
      setUploadingRowId(null);
    }
  }

  return (
    <div>
      <h1>商品管理</h1>
      <button
        type="button"
        className={showForm ? 'btn-secondary btn-small' : 'btn-primary btn-small'}
        onClick={() => setShowForm((v) => !v)}
      >
        {showForm ? 'キャンセル' : '新規作成'}
      </button>

      {showForm && (
        <form onSubmit={handleCreate} className="admin-form-card">
          <label>
            商品名
            <input type="text" value={name} onChange={(e) => setName(e.target.value)} required />
          </label>
          <label>
            slug
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
            価格(消費税10%)
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
          <label>
            商品画像を選択してアップロード(先頭が一覧・共有時のサムネイルになります)
            <input
              type="file"
              accept="image/png,image/jpeg,image/webp,image/gif"
              multiple
              disabled={uploadingNew}
              onChange={(e) => handleUploadForNewProduct(e.target.files)}
            />
          </label>
          {uploadingNew && <p>アップロード中です...</p>}
          <label>
            商品画像URL(アップロード済みの画像が自動で入ります。外部URLを直接指定することもできます)
            <textarea
              value={imagesText}
              onChange={(e) => setImagesText(e.target.value)}
              rows={3}
              placeholder={'https://example.com/image1.jpg\nhttps://example.com/image2.jpg'}
            />
          </label>
          {error && <p className="checkout-error">{error}</p>}
          <button type="submit" className="btn-primary">
            作成する
          </button>
        </form>
      )}

      {error && !showForm && <p className="checkout-error">{error}</p>}
      {statusMessage && <p className={statusMessage.type === 'error' ? 'checkout-error' : 'admin-status-success'}>{statusMessage.text}</p>}

      {products.length === 0 ? (
        <div className="admin-table-card">
          <EmptyState message="まだ商品がありません" actionLabel="新規作成" onAction={() => setShowForm(true)} />
        </div>
      ) : (
        <div className="admin-table-card">
          <table>
            <thead>
              <tr>
                <th>商品名</th>
                <th>slug</th>
                <th>タイプ</th>
                <th>価格</th>
                <th>ステータス</th>
                <th>バリエーション/在庫</th>
                <th>商品画像</th>
                <th>操作</th>
              </tr>
            </thead>
            <tbody>
              {products.map((p) => (
                <tr key={p.id}>
                  <td>
                    <input
                      type="text"
                      className="admin-inline-input--text"
                      defaultValue={p.name}
                      onBlur={(e) => e.target.value.trim() && e.target.value !== p.name && updateField(p, 'name', e.target.value.trim())}
                    />
                  </td>
                  <td>{p.slug}</td>
                  <td>
                    <select value={p.itemType} onChange={(e) => updateField(p, 'itemType', e.target.value)}>
                      {ITEM_TYPES.map((t) => (
                        <option key={t} value={t}>
                          {t}
                        </option>
                      ))}
                    </select>
                  </td>
                  <td>
                    <input
                      type="number"
                      className="admin-inline-input"
                      ref={(el) => {
                        priceInputRefs.current[p.id] = el;
                      }}
                      defaultValue={p.basePrice}
                      onBlur={(e) => {
                        // モード切替時に自動で入れた値のまま(実際には編集していない)なら何もしない。
                        if (e.target.value === priceAutoSetValueRefs.current[p.id]) return;
                        const entered = Number(e.target.value);
                        const finalPrice = toTaxIncluded(entered, rowPriceMode[p.id] ?? 'included');
                        if (finalPrice !== p.basePrice) updateField(p, 'basePrice', finalPrice);
                      }}
                    />
                    円
                    <select
                      className="admin-tax-mode__select"
                      value={rowPriceMode[p.id] ?? 'included'}
                      onChange={(e) => {
                        const mode = e.target.value as PriceMode;
                        setRowPriceMode((prev) => ({ ...prev, [p.id]: mode }));
                        // モード切替だけで金額が変わらないよう、表示中の数値をモードに合わせて
                        // 作り直す(税込表示中の数値をそのまま税別として送信してしまう事故を防ぐ)。
                        // ここで入れた値のまま編集されずにblurした場合は保存自体をスキップする。
                        const autoValue = String(mode === 'excluded' ? toTaxExcludedEstimate(p.basePrice) : p.basePrice);
                        priceAutoSetValueRefs.current[p.id] = autoValue;
                        const input = priceInputRefs.current[p.id];
                        if (input) input.value = autoValue;
                      }}
                    >
                      <option value="included">税込入力</option>
                      <option value="excluded">税別入力</option>
                    </select>
                  </td>
                  <td>
                    <StatusBadge status={p.status} />{' '}
                    <select value={p.status} onChange={(e) => updateStatus(p, e.target.value)}>
                      {STATUSES.map((s) => (
                        <option key={s} value={s}>
                          {s}
                        </option>
                      ))}
                    </select>
                  </td>
                  <td>
                    {p.variants.map((v) => (
                      <div key={v.id}>
                        {v.name}:
                        <input
                          type="number"
                          className="admin-inline-input"
                          defaultValue={v.stock}
                          onBlur={(e) => updateStock(p, v.id, v.name, Number(e.target.value))}
                        />
                      </div>
                    ))}
                  </td>
                  <td>
                    <input
                      type="file"
                      accept="image/png,image/jpeg,image/webp,image/gif"
                      multiple
                      disabled={uploadingRowId === p.id}
                      onChange={(e) => handleUploadForRow(p, e.target.files)}
                    />
                    {uploadingRowId === p.id && <p>アップロード中...</p>}
                    <textarea
                      ref={(el) => {
                        imagesTextareaRefs.current[p.id] = el;
                      }}
                      className="admin-inline-textarea"
                      defaultValue={p.images.join('\n')}
                      rows={2}
                      onBlur={(e) => updateImages(p, e.target.value)}
                      placeholder="画像URL(1行に1つ)"
                    />
                  </td>
                  <td>
                    <button type="button" className="btn-secondary btn-small" onClick={() => handleDelete(p)}>
                      削除
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
