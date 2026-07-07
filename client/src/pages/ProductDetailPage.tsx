import { useEffect, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { fetchProduct, type ProductDetail } from '../lib/api';
import { useCart } from '../context/CartContext';

export default function ProductDetailPage() {
  const { idOrSlug } = useParams<{ idOrSlug: string }>();
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
      .catch((e) => setError(e.message))
      .finally(() => setLoading(false));
  }, [idOrSlug]);

  if (loading) return <p>読み込み中です...</p>;
  if (error) return <p>読み込みに失敗しました: {error}</p>;
  if (!product) return null;

  const selectedVariant = product.variants.find((v) => v.id === variantId) ?? product.variants[0];

  return (
    <div className="product-detail">
      {product.images.length > 0 && (
        <div className="product-detail__gallery">
          <img src={product.images[activeImageIndex] ?? product.images[0]} alt={product.name} fetchPriority="high" />
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
      <h1>{product.name}</h1>
      <p>{product.description}</p>
      <p>{product.basePrice.toLocaleString()}円(税込)</p>

      <fieldset>
        <legend>バリエーション</legend>
        {product.variants.map((variant) => (
          <label key={variant.id}>
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
            {variant.name}(在庫 {variant.availableStock})
          </label>
        ))}
      </fieldset>

      <label>
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
        className="btn-primary"
        disabled={!selectedVariant || selectedVariant.availableStock === 0}
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
        カートに追加
      </button>
      {added && (
        <p>
          カートに追加しました。<Link to="/cart">カートを見る</Link>
        </p>
      )}
    </div>
  );
}
