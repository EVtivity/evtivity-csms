// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import Fastify from 'fastify';
import type { FastifyInstance } from 'fastify';

const { mockIngestPaymentWebhook, mockPaymentContext } = vi.hoisted(() => ({
  mockIngestPaymentWebhook: vi.fn(),
  mockPaymentContext: vi.fn((logger: unknown) => ({ registry: 'registry', logger })),
}));

vi.mock('@evtivity/payments', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@evtivity/payments')>()),
  ingestPaymentWebhook: mockIngestPaymentWebhook,
}));

vi.mock('../lib/payments.js', () => ({
  paymentContext: mockPaymentContext,
}));

import { WebhookNotConfiguredError, WebhookSignatureError } from '@evtivity/payments';
import { webhookRoutes } from '../routes/webhooks.js';

const RAW_BODY = '{"id":"evt_1","type":"charge.refunded","data":{"object":{}}}';

async function buildApp(): Promise<FastifyInstance> {
  const app = Fastify();
  await app.register(webhookRoutes);
  await app.ready();
  return app;
}

describe('Webhook routes', () => {
  let app: FastifyInstance;

  beforeAll(async () => {
    app = await buildApp();
  });

  afterAll(async () => {
    await app.close();
  });

  function postWebhook(headers: Record<string, string> = {}) {
    return app.inject({
      method: 'POST',
      url: '/webhooks/stripe',
      headers: { 'content-type': 'application/json', ...headers },
      payload: RAW_BODY,
    });
  }

  it('acknowledges the event after ingesting the raw body and lower-cased headers', async () => {
    mockIngestPaymentWebhook.mockResolvedValueOnce({ status: 'applied' });

    const res = await postWebhook({ 'Stripe-Signature': 't=1,v1=abc' });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ received: true });
    expect(mockIngestPaymentWebhook).toHaveBeenCalledTimes(1);
    const [providerId, rawBody, headers, ctx] = mockIngestPaymentWebhook.mock.calls[0] as [
      string,
      unknown,
      Record<string, string>,
      unknown,
    ];
    expect(providerId).toBe('stripe');
    // The body reaches the provider unparsed, so the signature covers the exact bytes.
    expect(rawBody).toBe(RAW_BODY);
    expect(headers['stripe-signature']).toBe('t=1,v1=abc');
    expect(headers['content-type']).toBe('application/json');
    expect(Object.keys(headers).every((name) => name === name.toLowerCase())).toBe(true);
    expect(Object.values(headers).every((value) => typeof value === 'string')).toBe(true);
    expect(ctx).toEqual({ registry: 'registry', logger: expect.anything() });
    expect(mockPaymentContext).toHaveBeenCalledTimes(1);
  });

  it('returns 500 WEBHOOK_NOT_CONFIGURED when the signing secret is not set', async () => {
    mockIngestPaymentWebhook.mockRejectedValueOnce(new WebhookNotConfiguredError('stripe'));

    const res = await postWebhook({ 'stripe-signature': 't=1,v1=abc' });

    expect(res.statusCode).toBe(500);
    expect(res.json()).toEqual({
      error: 'Webhook not configured',
      code: 'WEBHOOK_NOT_CONFIGURED',
    });
  });

  it('returns 400 WEBHOOK_SIGNATURE_MISSING when the signature header is absent', async () => {
    mockIngestPaymentWebhook.mockRejectedValueOnce(
      new WebhookSignatureError('missing', 'Missing stripe-signature header'),
    );

    const res = await postWebhook();

    expect(res.statusCode).toBe(400);
    expect(res.json()).toEqual({
      error: 'Missing stripe-signature header',
      code: 'WEBHOOK_SIGNATURE_MISSING',
    });
  });

  it('returns 400 WEBHOOK_SIGNATURE_INVALID when the signature does not verify', async () => {
    mockIngestPaymentWebhook.mockRejectedValueOnce(
      new WebhookSignatureError('invalid', 'No signatures found matching the expected signature'),
    );

    const res = await postWebhook({ 'stripe-signature': 't=1,v1=wrong' });

    expect(res.statusCode).toBe(400);
    expect(res.json()).toEqual({ error: 'Invalid signature', code: 'WEBHOOK_SIGNATURE_INVALID' });
  });

  it('propagates an unexpected error as a 500', async () => {
    mockIngestPaymentWebhook.mockRejectedValueOnce(new Error('database unavailable'));

    const res = await postWebhook({ 'stripe-signature': 't=1,v1=abc' });

    expect(res.statusCode).toBe(500);
    expect(res.json()).not.toHaveProperty('received');
  });
});
