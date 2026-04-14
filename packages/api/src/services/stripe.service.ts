// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import Stripe from 'stripe';
import { eq } from 'drizzle-orm';
import { db } from '@evtivity/database';
import { sitePaymentConfigs, settings } from '@evtivity/database';
import { decryptString } from '@evtivity/lib';
import { config as apiConfig } from '../lib/config.js';

export interface StripeConfig {
  stripe: Stripe;
  publishableKey: string;
  currency: string;
  preAuthAmountCents: number;
  configId: number | null;
  connectedAccountId: string | null;
  platformFeePercent: number;
}

interface CachedInstance {
  config: StripeConfig;
  expiresAt: number;
}

const CACHE_TTL_MS = 5 * 60 * 1000;
const instanceCache = new Map<string, CachedInstance>();

function getEncryptionKey(): string {
  const key = apiConfig.SETTINGS_ENCRYPTION_KEY;
  if (key === '') {
    throw new Error('SETTINGS_ENCRYPTION_KEY environment variable is required');
  }
  return key;
}

function createStripeInstance(secretKey: string): Stripe {
  return new Stripe(secretKey);
}

async function getPlatformStripeSettings(): Promise<{
  secretKeyEnc: string;
  publishableKey: string;
  currency: string;
  preAuthAmountCents: number;
  platformFeePercent: number;
} | null> {
  const keys = [
    'stripe.secretKeyEnc',
    'stripe.publishableKey',
    'stripe.currency',
    'stripe.preAuthAmountCents',
    'stripe.platformFeePercent',
  ];

  const rows = await db.select().from(settings);
  const settingsMap = new Map<string, unknown>();
  for (const row of rows) {
    if (keys.includes(row.key)) {
      settingsMap.set(row.key, row.value);
    }
  }

  const secretKeyEnc = settingsMap.get('stripe.secretKeyEnc') as string | undefined;
  const publishableKey = settingsMap.get('stripe.publishableKey') as string | undefined;

  if (secretKeyEnc == null || publishableKey == null) return null;

  return {
    secretKeyEnc,
    publishableKey,
    currency: (settingsMap.get('stripe.currency') as string | undefined) ?? 'USD',
    preAuthAmountCents:
      (settingsMap.get('stripe.preAuthAmountCents') as number | undefined) ?? 5000,
    platformFeePercent: Number(settingsMap.get('stripe.platformFeePercent') ?? 0),
  };
}

export async function getStripeConfig(siteId: string | null): Promise<StripeConfig | null> {
  const cacheKey = siteId ?? 'platform';
  const cached = instanceCache.get(cacheKey);
  if (cached != null && cached.expiresAt > Date.now()) {
    return cached.config;
  }

  const platformSettings = await getPlatformStripeSettings();
  if (platformSettings == null) return null;

  const encryptionKey = getEncryptionKey();
  const secretKey = decryptString(platformSettings.secretKeyEnc, encryptionKey);
  const stripe = createStripeInstance(secretKey);

  let connectedAccountId: string | null = null;
  let currency = platformSettings.currency;
  let preAuthAmountCents = platformSettings.preAuthAmountCents;
  let configId: number | null = null;
  let sitePlatformFeePercent: number | null = null;

  if (siteId != null) {
    const [siteConfig] = await db
      .select()
      .from(sitePaymentConfigs)
      .where(eq(sitePaymentConfigs.siteId, siteId));

    if (siteConfig != null && siteConfig.isEnabled) {
      connectedAccountId = siteConfig.stripeConnectedAccountId ?? null;
      currency = siteConfig.currency;
      preAuthAmountCents = siteConfig.preAuthAmountCents;
      configId = siteConfig.id;
      if (siteConfig.platformFeePercent != null) {
        sitePlatformFeePercent = Number(siteConfig.platformFeePercent);
      }
    }
  }

  const config: StripeConfig = {
    stripe,
    publishableKey: platformSettings.publishableKey,
    currency,
    preAuthAmountCents,
    configId,
    connectedAccountId,
    platformFeePercent: sitePlatformFeePercent ?? platformSettings.platformFeePercent,
  };
  instanceCache.set(cacheKey, { config, expiresAt: Date.now() + CACHE_TTL_MS });
  return config;
}

export async function isPaymentEnabled(): Promise<boolean> {
  const platformSettings = await getPlatformStripeSettings();
  return platformSettings != null;
}

export async function createPreAuthorization(
  config: StripeConfig,
  customerId: string,
  paymentMethodId: string,
  amountCents?: number,
): Promise<Stripe.PaymentIntent> {
  const amount = amountCents ?? config.preAuthAmountCents;
  const params: Stripe.PaymentIntentCreateParams = {
    amount,
    currency: config.currency.toLowerCase(),
    customer: customerId,
    payment_method: paymentMethodId,
    capture_method: 'manual',
    confirm: true,
    off_session: true,
  };

  if (config.connectedAccountId != null) {
    params.on_behalf_of = config.connectedAccountId;
    params.transfer_data = { destination: config.connectedAccountId };
    if (config.platformFeePercent > 0) {
      params.application_fee_amount = Math.round((amount * config.platformFeePercent) / 100);
    }
  }

  return config.stripe.paymentIntents.create(params);
}

export async function capturePayment(
  config: StripeConfig,
  paymentIntentId: string,
  amountCents: number,
): Promise<Stripe.PaymentIntent> {
  return config.stripe.paymentIntents.capture(paymentIntentId, {
    amount_to_capture: amountCents,
  });
}

export async function cancelPaymentIntent(
  config: StripeConfig,
  paymentIntentId: string,
): Promise<Stripe.PaymentIntent> {
  return config.stripe.paymentIntents.cancel(paymentIntentId);
}

export async function createRefund(
  config: StripeConfig,
  paymentIntentId: string,
  amountCents?: number,
): Promise<Stripe.Refund> {
  const params: Stripe.RefundCreateParams = {
    payment_intent: paymentIntentId,
  };
  if (amountCents != null) {
    params.amount = amountCents;
  }
  const idempotencyKey = `refund_${paymentIntentId}_${String(amountCents ?? 'full')}`;
  return config.stripe.refunds.create(params, { idempotencyKey });
}

export async function createSetupIntent(
  config: StripeConfig,
  customerId: string,
): Promise<Stripe.SetupIntent> {
  return config.stripe.setupIntents.create({
    customer: customerId,
    payment_method_types: ['card'],
  });
}

export async function createCustomer(
  config: StripeConfig,
  email: string,
  name: string,
): Promise<Stripe.Customer> {
  return config.stripe.customers.create({ email, name });
}

export async function detachPaymentMethod(
  config: StripeConfig,
  paymentMethodId: string,
): Promise<Stripe.PaymentMethod> {
  return config.stripe.paymentMethods.detach(paymentMethodId);
}

export function clearConfigCache(): void {
  instanceCache.clear();
}

export function verifyWebhookSignature(
  body: string,
  signature: string,
  webhookSecret: string,
): Stripe.Event {
  const stripe = new Stripe('sk_unused_for_webhook_verification');
  return stripe.webhooks.constructEvent(body, signature, webhookSecret);
}
