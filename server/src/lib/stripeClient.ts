import Stripe from 'stripe';
import { getSetting } from '../services/settings';
import { HttpError } from './httpError';

export async function getStripeClient(): Promise<Stripe> {
  const key = await getSetting('stripe_secret_key');
  if (!key) {
    throw new HttpError(500, 'STRIPE_NOT_CONFIGURED', 'Stripeのシークレットキーが設定されていません');
  }
  return new Stripe(key);
}

export async function getStripeWebhookSecret(): Promise<string> {
  const secret = await getSetting('stripe_webhook_secret');
  if (!secret) {
    throw new HttpError(500, 'STRIPE_NOT_CONFIGURED', 'StripeのWebhookシークレットが設定されていません');
  }
  return secret;
}
