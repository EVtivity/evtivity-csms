// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import Fastify from 'fastify';
import type { FastifyInstance } from 'fastify';

const m = vi.hoisted(() => ({
  ingestPaymentWebhook: vi.fn(),
  ingestTerminalWebhook: vi.fn(),
  dispatchNotices: vi.fn(),
  handleTerminalResults: vi.fn(),
  paymentContext: vi.fn((_logger: unknown, actor: unknown) => ({ registry: 'registry', actor })),
}));

vi.mock('@evtivity/payments', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@evtivity/payments')>()),
  ingestPaymentWebhook: m.ingestPaymentWebhook,
  ingestTerminalWebhook: m.ingestTerminalWebhook,
  dispatchPaymentWebhookNotices: m.dispatchNotices,
}));
vi.mock('@evtivity/services/payment-terminal-flow', () => ({
  handleTerminalResults: m.handleTerminalResults,
}));
vi.mock('../lib/payments.js', () => ({ paymentContext: m.paymentContext }));
vi.mock('@evtivity/lib/pubsub-instance', () => ({ getPubSub: () => ({ publish: vi.fn() }) }));

import { TerminalProviderError } from '@evtivity/payment-terminals';
import { WebhookNotConfiguredError, WebhookSignatureError } from '@evtivity/payments';
import { webhookRoutes } from '../routes/webhooks.js';

const BODY = '{"id":"evt_1","type":"transaction.updated"}';

let app: FastifyInstance;

beforeAll(async () => {
  app = Fastify();
  await app.register(webhookRoutes);
  await app.ready();
});

afterAll(async () => {
  await app.close();
});

function postTerminal(headers: Record<string, string | string[]> = {}) {
  return app.inject({
    method: 'POST',
    url: '/webhooks/payment-terminals/idtech',
    headers: { 'content-type': 'application/json', ...headers },
    payload: BODY,
  });
}

describe('POST /webhooks/payment-terminals/idtech', () => {
  it('ingests the raw body, then hands the applied results to the terminal flow', async () => {
    const applied = [{ transactionId: 'ptx_1', state: 'authorized' }];
    m.ingestTerminalWebhook.mockResolvedValueOnce({ applied });
    const res = await postTerminal({ 'x-psg-signature': 't=1,v1=abc' });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ received: true });
    const [provider, raw, headers, ctx] = m.ingestTerminalWebhook.mock.calls[0] as [
      string,
      Buffer,
      Record<string, string>,
      unknown,
    ];
    expect(provider).toBe('idtech');
    expect(raw.toString('utf8')).toBe(BODY);
    expect(headers['x-psg-signature']).toBe('t=1,v1=abc');
    expect(ctx).toEqual({
      registry: 'registry',
      actor: { actor: 'system', actorLabel: 'terminal-webhook:idtech' },
    });
    expect(m.handleTerminalResults).toHaveBeenCalledWith(
      applied,
      'idtech',
      expect.objectContaining({ portalUrl: expect.any(String) }),
    );
  });

  it('answers 500 WEBHOOK_NOT_CONFIGURED without the secret', async () => {
    m.ingestTerminalWebhook.mockRejectedValueOnce(new WebhookNotConfiguredError('idtech'));
    const res = await postTerminal();
    expect(res.statusCode).toBe(500);
    expect(res.json()).toEqual({ error: 'Webhook not configured', code: 'WEBHOOK_NOT_CONFIGURED' });
    expect(m.handleTerminalResults).not.toHaveBeenCalled();
  });

  it('answers 401 for a refused signature and 400 for an invalid event', async () => {
    m.ingestTerminalWebhook.mockRejectedValueOnce(new TerminalProviderError('auth', 'bad sig'));
    const auth = await postTerminal();
    expect(auth.statusCode).toBe(401);
    expect(auth.json()).toEqual({ error: 'Invalid signature', code: 'WEBHOOK_SIGNATURE_INVALID' });
    m.ingestTerminalWebhook.mockRejectedValueOnce(new TerminalProviderError('validation', 'bad'));
    const invalid = await postTerminal();
    expect(invalid.statusCode).toBe(400);
    expect(invalid.json()).toEqual({ error: 'Invalid event', code: 'VALIDATION_ERROR' });
    expect(m.handleTerminalResults).not.toHaveBeenCalled();
  });

  it('passes any other provider error to the 500 handler so the gateway retries', async () => {
    m.ingestTerminalWebhook.mockRejectedValueOnce(new TerminalProviderError('unavailable', 'down'));
    const res = await postTerminal();
    expect(res.statusCode).toBe(500);
    expect(m.handleTerminalResults).not.toHaveBeenCalled();
  });
});

describe('POST /webhooks/payments/:provider', () => {
  it('joins a repeated header and answers 401 for refused Adyen credentials', async () => {
    m.ingestPaymentWebhook.mockRejectedValueOnce(
      new WebhookSignatureError('invalid', 'wrong credentials', {
        kind: 'auth',
        unverified: { pspReference: 'psp_1' },
      }),
    );
    const res = await app.inject({
      method: 'POST',
      url: '/webhooks/payments/adyen',
      headers: { 'content-type': 'application/json', 'x-extra': ['a', 'b'] },
      payload: BODY,
    });
    expect(res.statusCode).toBe(401);
    expect(res.json<{ code: string }>().code).toBe('WEBHOOK_SIGNATURE_INVALID');
    const headers = m.ingestPaymentWebhook.mock.calls[0]?.[2] as Record<string, string>;
    expect(headers['x-extra']).toBe('a,b');
  });

  it('dispatches the notices of the applied events before the acknowledgement', async () => {
    const notices = [{ kind: 'payment_failed', driverId: 'drv_1' }];
    m.ingestPaymentWebhook.mockResolvedValueOnce({
      ack: { status: 200, contentType: 'application/json', body: '{"received":true}' },
      applied: 1,
      duplicates: 0,
      notices,
    });
    m.dispatchNotices.mockResolvedValueOnce(undefined);
    const res = await app.inject({
      method: 'POST',
      url: '/webhooks/payments/stripe',
      headers: { 'content-type': 'application/json' },
      payload: BODY,
    });
    expect(res.statusCode).toBe(200);
    expect(m.dispatchNotices).toHaveBeenCalledWith(
      notices,
      expect.objectContaining({ templatesDirs: expect.any(Array) }),
    );
  });
});
