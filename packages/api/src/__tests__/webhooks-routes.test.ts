// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import Fastify from 'fastify';
import type { FastifyInstance } from 'fastify';

const { mockIngestPaymentWebhook, mockPaymentContext, mockDispatchNotices } = vi.hoisted(() => ({
  mockIngestPaymentWebhook: vi.fn(),
  mockDispatchNotices: vi.fn(),
  mockPaymentContext: vi.fn((logger: unknown) => ({ registry: 'registry', logger })),
}));

vi.mock('@evtivity/payments', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@evtivity/payments')>()),
  ingestPaymentWebhook: mockIngestPaymentWebhook,
  dispatchPaymentWebhookNotices: mockDispatchNotices,
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

  function postWebhook(headers: Record<string, string> = {}, provider = 'stripe') {
    return app.inject({
      method: 'POST',
      url: `/webhooks/payments/${provider}`,
      headers: { 'content-type': 'application/json', ...headers },
      payload: RAW_BODY,
    });
  }

  const STRIPE_ACK = {
    ack: { status: 200, contentType: 'application/json', body: '{"received":true}' },
    applied: 1,
    duplicates: 0,
    notices: [],
  };
  const ADYEN_ACK = {
    ack: { status: 200, contentType: 'text/plain', body: '[accepted]' },
    applied: 1,
    duplicates: 0,
    notices: [],
  };

  it('no longer serves the old Stripe path (D-P9)', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/webhooks/stripe',
      headers: { 'content-type': 'application/json', 'stripe-signature': 't=1,v1=abc' },
      payload: RAW_BODY,
    });

    expect(res.statusCode).toBe(404);
    expect(mockIngestPaymentWebhook).not.toHaveBeenCalled();
  });

  it('acknowledges the event after ingesting the raw body and lower-cased headers', async () => {
    mockIngestPaymentWebhook.mockResolvedValueOnce(STRIPE_ACK);

    const res = await postWebhook({ 'Stripe-Signature': 't=1,v1=abc' });

    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toMatch(/^application\/json/);
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

  it('answers Adyen with the provider acknowledgement as plain text', async () => {
    mockIngestPaymentWebhook.mockResolvedValueOnce(ADYEN_ACK);

    const res = await postWebhook({ authorization: 'Basic dXNlcjpwYXNz' }, 'adyen');

    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toMatch(/^text\/plain/);
    expect(res.body).toBe('[accepted]');
    const [providerId, rawBody, headers] = mockIngestPaymentWebhook.mock.calls[0] as [
      string,
      unknown,
      Record<string, string>,
    ];
    expect(providerId).toBe('adyen');
    expect(rawBody).toBe(RAW_BODY);
    expect(headers['authorization']).toBe('Basic dXNlcjpwYXNz');
    expect(mockDispatchNotices).not.toHaveBeenCalled();
  });

  it('dispatches the notices of the applied events before acknowledging', async () => {
    const notices = [{ kind: 'capture_failed', record: { id: 1 }, reason: null }];
    mockIngestPaymentWebhook.mockResolvedValueOnce({ ...ADYEN_ACK, notices });

    const res = await postWebhook({ authorization: 'Basic dXNlcjpwYXNz' }, 'adyen');

    expect(res.statusCode).toBe(200);
    expect(mockDispatchNotices).toHaveBeenCalledWith(notices, {
      templatesDirs: expect.any(Array) as unknown,
      pubsub: expect.anything() as unknown,
      logger: expect.anything() as unknown,
    });
  });

  it.each(['stripe', 'adyen'])(
    'returns 500 WEBHOOK_NOT_CONFIGURED on %s when the provider has no secret',
    async (provider) => {
      mockIngestPaymentWebhook.mockRejectedValueOnce(new WebhookNotConfiguredError(provider));

      const res = await postWebhook({}, provider);

      expect(res.statusCode).toBe(500);
      expect(res.json()).toEqual({
        error: 'Webhook not configured',
        code: 'WEBHOOK_NOT_CONFIGURED',
      });
    },
  );

  it('returns 400 WEBHOOK_SIGNATURE_MISSING when the signature header is absent', async () => {
    mockIngestPaymentWebhook.mockRejectedValueOnce(
      new WebhookSignatureError('missing', 'Missing stripe-signature header'),
    );

    const res = await postWebhook();

    expect(res.statusCode).toBe(400);
    expect(res.json()).toEqual({
      error: 'Missing webhook signature or credentials',
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

  it('returns 401 WEBHOOK_SIGNATURE_MISSING when Adyen Basic auth is absent', async () => {
    mockIngestPaymentWebhook.mockRejectedValueOnce(
      new WebhookSignatureError('missing', 'Missing Basic auth', { kind: 'auth' }),
    );

    const res = await postWebhook({}, 'adyen');

    expect(res.statusCode).toBe(401);
    expect(res.json()).toEqual({
      error: 'Missing webhook signature or credentials',
      code: 'WEBHOOK_SIGNATURE_MISSING',
    });
  });

  it('returns 401 WEBHOOK_SIGNATURE_INVALID when Adyen Basic auth is wrong', async () => {
    mockIngestPaymentWebhook.mockRejectedValueOnce(
      new WebhookSignatureError('invalid', 'Wrong Basic auth', { kind: 'auth' }),
    );

    const res = await postWebhook({ authorization: 'Basic d3Jvbmc6d3Jvbmc=' }, 'adyen');

    expect(res.statusCode).toBe(401);
    expect(res.json()).toEqual({ error: 'Invalid signature', code: 'WEBHOOK_SIGNATURE_INVALID' });
  });

  it('returns 400 WEBHOOK_SIGNATURE_INVALID when an Adyen item HMAC is wrong', async () => {
    mockIngestPaymentWebhook.mockRejectedValueOnce(
      new WebhookSignatureError('invalid', 'HMAC signature does not match'),
    );

    const res = await postWebhook({ authorization: 'Basic dXNlcjpwYXNz' }, 'adyen');

    expect(res.statusCode).toBe(400);
    expect(res.json()).toEqual({ error: 'Invalid signature', code: 'WEBHOOK_SIGNATURE_INVALID' });
  });

  it.each(['stripe', 'adyen'])(
    'propagates an unexpected error on %s as a 500 so the provider retries',
    async (provider) => {
      mockIngestPaymentWebhook.mockRejectedValueOnce(new Error('database unavailable'));

      const res = await postWebhook({ 'stripe-signature': 't=1,v1=abc' }, provider);

      expect(res.statusCode).toBe(500);
      expect(res.body).not.toContain('received');
      expect(res.body).not.toContain('[accepted]');
    },
  );
});
