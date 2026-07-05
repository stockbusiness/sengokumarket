import type { Request, Response } from 'express';
import Stripe from 'stripe';
import { Prisma } from '@prisma/client';
import { prisma } from '../lib/prisma';
import { getStripeWebhookSecret } from '../lib/stripeClient';
import {
  handleChargeRefunded,
  handleCheckoutSessionCompleted,
  handleCheckoutSessionExpired,
  handlePaymentIntentFailed,
} from '../services/stripeWebhookHandlers';

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

  // 冪等性: stripe_eventsにevent_idをINSERT(UNIQUE)。重複なら即200(仕様書v1.5 6.9 / 7.3)
  try {
    await prisma.stripeEvent.create({
      data: { stripeEventId: event.id, eventType: event.type, processedAt: new Date() },
    });
  } catch (e) {
    if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2002') {
      return res.status(200).json({ received: true, duplicate: true });
    }
    console.error('failed to record stripe event', e);
    return res.status(500).json({ error: { code: 'INTERNAL_ERROR', message: 'internal error' } });
  }

  try {
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
    res.status(200).json({ received: true });
  } catch (e) {
    console.error('stripe webhook handling error', e);
    res.status(500).json({ error: { code: 'WEBHOOK_HANDLING_ERROR', message: 'internal error' } });
  }
}
