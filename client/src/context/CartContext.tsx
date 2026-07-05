import { createContext, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';
import { type CartItem, loadCart, saveCart } from '../lib/cart';

interface CartContextValue {
  items: CartItem[];
  addItem: (item: Omit<CartItem, 'quantity'>, quantity: number) => void;
  updateQuantity: (variantId: string, quantity: number) => void;
  removeItem: (variantId: string) => void;
  replaceItems: (items: CartItem[]) => void;
  totalAmount: number;
}

const CartContext = createContext<CartContextValue | null>(null);

export function CartProvider({ children }: { children: ReactNode }) {
  const [items, setItems] = useState<CartItem[]>(() => loadCart());

  useEffect(() => {
    saveCart(items);
  }, [items]);

  const addItem: CartContextValue['addItem'] = (item, quantity) => {
    setItems((prev) => {
      const existing = prev.find((i) => i.variantId === item.variantId);
      if (existing) {
        return prev.map((i) =>
          i.variantId === item.variantId ? { ...i, quantity: i.quantity + quantity } : i,
        );
      }
      return [...prev, { ...item, quantity }];
    });
  };

  const updateQuantity: CartContextValue['updateQuantity'] = (variantId, quantity) => {
    setItems((prev) =>
      prev.map((i) => (i.variantId === variantId ? { ...i, quantity: Math.max(quantity, 1) } : i)),
    );
  };

  const removeItem: CartContextValue['removeItem'] = (variantId) => {
    setItems((prev) => prev.filter((i) => i.variantId !== variantId));
  };

  const replaceItems: CartContextValue['replaceItems'] = (next) => {
    setItems(next);
  };

  const totalAmount = useMemo(() => items.reduce((sum, i) => sum + i.price * i.quantity, 0), [items]);

  return (
    <CartContext.Provider value={{ items, addItem, updateQuantity, removeItem, replaceItems, totalAmount }}>
      {children}
    </CartContext.Provider>
  );
}

export function useCart() {
  const ctx = useContext(CartContext);
  if (!ctx) throw new Error('useCart must be used within CartProvider');
  return ctx;
}
