import { useEffect, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { ApiError, fetchProduct, type ProductDetail } from '../lib/api';
import { useCart } from '../context/CartContext';
import { getEffectiveReferralCode } from '../lib/referral';

export default function ProductDetailPage() {
  const { idOrSlug } = useParams<{ idOrSlug: string }>();
  const navigate = useNavigate();
  const { addItem } = useCart();
  const [product, setProduct] = useState<ProductDetail | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [variantId, setVariantId] = useState<string>('');
  const [quantity, setQuantity] = useState(1);
  const [added, setAdded] = useState(false);
  const [activeImageIndex, setActiveImageIndex] = useState(0);

  useEffect(() => {
    if (!idOrSlug) return;
    setLoading(true);
    fetchProduct(idOrSlug)
      .then((data) => {
        setProduct(data.product);
        setVariantId(data.product.variants[0]?.id ?? '');
        setActiveImageIndex(0);
      })
      .catch((e) => {
        // 仕様書外の拡張(2026-07-22): 商品ごとの個別リンクは統一先(/products)へ移行済みだが、
        // 既に配布済みの旧リンク(削除・非公開・リネームされた商品を指すもの)を開いた場合、
        // エラー画面で行き止まりにせず、紹介コードを保持したまま商品一覧へ誘導する。
        if (e instanceof ApiError && e.code === 'PRODUCT_NOT_FOUND') {
          const ref = getEffectiveReferralCode();
          navigate(ref ? `/products?ref=${encodeURIComponent(ref)}` : '/products', { replace: true });
          return;
        }
        setError(e.message);
      })
      .finally(() => setLoading(false));
  }, [idOrSlug, navigate]);

  if (loading) return <p>読み込み中です...</p>;
  if (error) return <p>読み込みに失敗しました: {error}</p>;
  if (!product) return null;

  const selectedVariant = product.variants.find((v) => v.id === variantId) ?? product.variants[0];
  const soldOut = !selectedVariant || selectedVariant.availableStock === 0;

  return (
    <div className="product-detail">
      <div className="product-detail__layout">
        {product.images.length > 0 && (
          <div className="product-detail__gallery">
            <img
              className="product-detail__main-image"
              src={product.images[activeImageIndex] ?? product.images[0]}
              alt={product.name}
              fetchPriority="high"
            />
            {product.images.length > 1 && (
              <div className="product-detail__thumbnails">
                {product.images.map((src, index) => (
                  <button
                    key={src}
                    type="button"
                    className={index === activeImageIndex ? 'product-detail__thumbnail is-active' : 'product-detail__thumbnail'}
                    onClick={() => setActiveImageIndex(index)}
                  >
                    <img src={src} alt={`${product.name} 画像${index + 1}`} loading="lazy" />
                  </button>
                ))}
              </div>
            )}
          </div>
        )}

        <div className="product-detail__info">
          <h1 className="product-detail__name">{product.name}</h1>
          <p className="product-detail__price">
            {(selectedVariant?.price ?? product.basePrice).toLocaleString()}円<span>(税込)</span>
          </p>

          {product.variants.length > 1 ? (
            <fieldset className="product-detail__variants">
              <legend>種類を選択</legend>
              {product.variants.map((variant) => (
                <label
                  key={variant.id}
                  className={
                    variantId === variant.id ? 'product-detail__variant-option is-active' : 'product-detail__variant-option'
                  }
                >
                  <input
                    type="radio"
                    name="variant"
                    value={variant.id}
                    checked={variantId === variant.id}
                    onChange={() => {
                      setVariantId(variant.id);
                      setQuantity(1);
                    }}
                  />
                  <span className="product-detail__variant-name">{variant.name}</span>
                  <span className="product-detail__variant-stock">
                    {variant.availableStock > 0 ? `残り${variant.availableStock}` : '売り切れ'}
                  </span>
                </label>
              ))}
            </fieldset>
          ) : (
            selectedVariant && (
              <p className={soldOut ? 'product-detail__stock is-soldout' : 'product-detail__stock'}>
                {soldOut ? '売り切れ' : `在庫あり(残り${selectedVariant.availableStock})`}
              </p>
            )
          )}

          <div className="product-detail__purchase">
            <label className="product-detail__quantity">
              数量
              <input
                type="number"
                min={1}
                max={Math.max(selectedVariant?.availableStock ?? 1, 1)}
                value={quantity}
                onChange={(e) => setQuantity(Number(e.target.value))}
              />
            </label>
            <button
              type="button"
              className="btn-primary product-detail__add-button"
              disabled={soldOut}
              onClick={() => {
                if (!selectedVariant) return;
                addItem(
                  {
                    productId: product.id,
                    productSlug: product.slug,
                    productName: product.name,
                    variantId: selectedVariant.id,
                    variantName: selectedVariant.name,
                    price: selectedVariant.price,
                  },
                  quantity,
                );
                setAdded(true);
              }}
            >
              {soldOut ? '売り切れ' : 'カートに追加'}
            </button>
          </div>
          {added && (
            <p className="product-detail__added">
              カートに追加しました。<Link to="/cart">カートを見る</Link>
            </p>
          )}

          {product.description && (
            <div className="product-detail__description">
              <h2>商品説明</h2>
              <p>{product.description}</p>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
