import type { Order, OrderItem } from '@prisma/client';
import { getStripeClient } from '../lib/stripeClient';

// Stripeの商品名に「NFT」を含めない(仕様書v1.5 16章の絶対禁止事項)
export function toStripeSafeName(name: string): string {
  return name.replace(/nft/gi, 'デジタル会員証');
}

export async function createStripeCheckoutSession(order: Order, items: OrderItem[]) {
  const stripe = await getStripeClient();
  const appUrl = process.env.APP_URL;
  if (!appUrl) throw new Error('APP_URL is not set');

  // 仕様書外の拡張(クーポン機能): 各商品の単価はスナップショット原則により変更せず、
  // Stripeの1回限りCouponで割引を別枠として適用する(discounts配列)。
  let discounts: { coupon: string }[] | undefined;
  if (order.couponDiscountAmount > 0) {
    const stripeCoupon = await stripe.coupons.create({
      amount_off: order.couponDiscountAmount,
      currency: 'jpy',
      duration: 'once',
      max_redemptions: 1,
      name: order.couponCode ?? 'クーポン割引',
    });
    discounts = [{ coupon: stripeCoupon.id }];
  }

  return stripe.checkout.sessions.create({
    mode: 'payment',
    customer_email: order.customerEmail,
    success_url: `${appUrl}/checkout/success?session_id={CHECKOUT_SESSION_ID}`,
    cancel_url: `${appUrl}/checkout/cancel`,
    // 有効期限30分(仕様書v1.5 7.1)。Stripe側の最小許容値(30分)ちょうどだと
    // 処理遅延で弾かれる恐れがあるため60秒のバッファを加える。
    expires_at: Math.floor(Date.now() / 1000) + 30 * 60 + 60,
    line_items: items.map((item) => ({
      quantity: item.quantity,
      price_data: {
        currency: 'jpy',
        unit_amount: item.unitPrice,
        product_data: {
          name: [toStripeSafeName(item.productName), item.variantName].filter(Boolean).join(' '),
        },
      },
    })),
    discounts,
    // 仕様書外の拡張: 日本発行カードの分割払い(JCB最大24回、Visa/Mastercard最大60回)。
    // ダッシュボードの決済手段設定で有効化済みだが、payment_method_typesを将来指定した際に
    // 暗黙的に外れてしまわないよう明示的に有効化しておく。手数料・入金額への影響はない。
    payment_method_options: {
      card: {
        installments: { enabled: true },
      },
    },
    payment_intent_data: {
      metadata: { order_id: order.id },
    },
    metadata: {
      order_id: order.id,
      user_id: order.userId ?? '',
      referral_code: order.referralCode ?? '',
      coupon_code: order.couponCode ?? '',
    },
  });
}
