export interface CartItem {
  productId: string;
  productSlug: string;
  productName: string;
  variantId: string;
  variantName: string;
  price: number;
  quantity: number;
}

const STORAGE_KEY = 'sengoku_cart';
const TTL_DAYS = 7;

interface StoredCart {
  items: CartItem[];
  savedAt: string;
}

export function loadCart(): CartItem[] {
  const raw = localStorage.getItem(STORAGE_KEY);
  if (!raw) return [];

  try {
    const parsed: StoredCart = JSON.parse(raw);
    const savedAt = new Date(parsed.savedAt).getTime();
    const expired = Date.now() - savedAt > TTL_DAYS * 24 * 60 * 60 * 1000;
    if (expired) {
      localStorage.removeItem(STORAGE_KEY);
      return [];
    }
    return parsed.items ?? [];
  } catch {
    localStorage.removeItem(STORAGE_KEY);
    return [];
  }
}

export function saveCart(items: CartItem[]) {
  const payload: StoredCart = { items, savedAt: new Date().toISOString() };
  localStorage.setItem(STORAGE_KEY, JSON.stringify(payload));
}
