import type { Request, Response } from 'express';
import Stripe from 'stripe';
import { getStripeWebhookSecret } from '../lib/stripeClient';
import {
  handleChargeRefunded,
  handleCheckoutSessionCompleted,
  handleCheckoutSessionExpired,
  handlePaymentIntentFailed,
} from '../services/stripeWebhookHandlers';
import { claimStripeEventForProcessing, hashPayload, markStripeEventFailed, markStripeEventSucceeded } from '../services/stripeEventInbox';

export async function processStripeEvent(event: Stripe.Event): Promise<void> {
  switch (event.type) {
    case 'checkout.session.completed':
      await handleCheckoutSessionCompleted(event);
      break;
    case 'checkout.session.expired':
      await handleCheckoutSessionExpired(event);
      break;
    case 'payment_intent.payment_failed':
      await handlePaymentIntentFailed(event);
      break;
    case 'charge.refunded':
      await handleChargeRefunded(event);
      break;
    default:
      break;
  }
}

export async function stripeWebhookHandler(req: Request, res: Response) {
  const signature = req.headers['stripe-signature'];
  if (typeof signature !== 'string') {
    return res.status(400).send('missing stripe-signature header');
  }

  let webhookSecret: string;
  try {
    webhookSecret = await getStripeWebhookSecret();
  } catch {
    return res.status(500).send('stripe webhook secret is not configured');
  }

  let event: Stripe.Event;
  try {
    event = Stripe.webhooks.constructEvent(req.body, signature, webhookSecret);
  } catch (err) {
    console.error('stripe webhook signature verification failed', err);
    return res.status(400).send('signature verification failed');
  }

  // 冪等性(Inbox方式。仕様書外の拡張・千ノ国全体統合契約2026-07-21 5.4章): event_idをクレームした
  // 時点ではまだ「処理完了」を確定しない。業務処理が成功した後にのみsucceededへ遷移させることで、
  // 途中失敗時にStripeの再送で正しく再処理できるようにする(旧実装はINSERT即時に処理済み扱いにしていたため、
  // 再送しても二度と処理されない欠陥があった)。
  const payloadHash = hashPayload(req.body);
  const claim = await claimStripeEventForProcessing(event.id, event.type, payloadHash);

  switch (claim.outcome) {
    case 'payload_mismatch':
      console.error('stripe event payload mismatch for existing event id', { stripeEventId: event.id });
      return res.status(409).json({ error: { code: 'PAYLOAD_MISMATCH', message: 'event payload does not match previously recorded event' } });
    case 'already_succeeded':
      return res.status(200).json({ received: true, duplicate: true });
    case 'in_progress':
      // 別のリクエスト(同時再送・進行中の処理)が既にこのevent_idを処理している。
      // Stripeの再送ストームを避けるため200を返す(処理自体は進行中のものに委ねる)。
      return res.status(200).json({ received: true, inProgress: true });
    case 'failed_terminal':
      // 最大試行回数を超えて失敗し続けている。Stripeの自動再送には委ねず(無限リトライ防止)、
      // 200で受理した上で管理者による手動再試行(admin/stripe-events)を待つ。
      console.error('stripe event reached failed_terminal, manual retry required', { stripeEventId: event.id });
      return res.status(200).json({ received: true, failedTerminal: true });
    case 'process':
      break;
  }

  try {
    await processStripeEvent(event);
    await markStripeEventSucceeded(event.id);
    res.status(200).json({ received: true });
  } catch (e) {
    console.error('stripe webhook handling error', e);
    await markStripeEventFailed(event.id, e);
    res.status(500).json({ error: { code: 'WEBHOOK_HANDLING_ERROR', message: 'internal error' } });
  }
}
