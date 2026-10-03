// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { describe, it, expect, vi } from 'vitest';

vi.mock('@evtivity/database', () => ({ db: {}, settings: {}, sitePaymentConfigs: {} }));

import {
  SimulatedPaymentProvider,
  simulatedProviderFactory,
} from '../providers/simulated/index.js';
import type { SimulatedWebhookDelivery } from '../providers/simulated/index.js';
import { SIMULATED_TEST_CARDS, findTestCard } from '../providers/simulated/test-cards.js';
import { parsePaymentId, keyFraction } from '../providers/simulated/ids.js';
import crypto from 'node:crypto';
import {
  signSimulatedWebhook,
  simulatedWebhookKey,
} from '../providers/simulated/webhook-signing.js';
import {
  PaymentDeclinedError,
  PaymentMethodOwnershipError,
  PaymentValidationError,
  WebhookSignatureError,
} from '../errors.js';
import type { AuthorizeHoldInput } from '../types.js';
import { emptyAdyenSettings } from './helpers/settings.js';

const KEY = 'test-encryption-key-32chars-long!';

function luhnValid(number: string): boolean {
  let sum = 0;
  for (let i = 0; i < number.length; i++) {
    let d = Number(number[number.length - 1 - i]);
    if (i % 2 === 1) {
      d *= 2;
      if (d > 9) d -= 9;
    }
    sum += d;
  }
  return sum % 10 === 0;
}

function sync(options: Partial<ConstructorParameters<typeof SimulatedPaymentProvider>[0]> = {}) {
  return new SimulatedPaymentProvider({ encryptionKey: KEY, ...options });
}

function asyncProvider() {
  const deliveries: SimulatedWebhookDelivery[] = [];
  const provider = new SimulatedPaymentProvider({
    encryptionKey: KEY,
    resultMode: 'async',
    events: {
      deliver: (d) => {
        deliveries.push(d);
        return Promise.resolve();
      },
    },
  });
  return { provider, deliveries };
}

async function savedMethod(provider: SimulatedPaymentProvider, testCard: string, key = 'm1') {
  const step = await provider.submitMethodSetup({
    customerId: 'cus_sim_1',
    payload: { testCard },
    idempotencyKey: key,
  });
  if (step.status !== 'saved') throw new Error(`expected saved, got ${step.status}`);
  return step.method;
}

function hold(methodId: string, overrides: Partial<AuthorizeHoldInput> = {}): AuthorizeHoldInput {
  return {
    idempotencyKey: 'preauth_s1',
    method: { kind: 'saved', customerId: 'cus_sim_1', methodId },
    initiator: 'merchant',
    merchantReference: 'sess_s1',
    amountCents: 5000,
    currency: 'USD',
    payoutAccountId: null,
    ...overrides,
  };
}

function captureInput(paymentId: string, key = 'capture_1') {
  return {
    idempotencyKey: key,
    paymentId,
    amountCents: 3000,
    currency: 'USD',
    merchantReference: 'sess_s1',
    payoutAccountId: null,
    feeTax: 0,
    platformFeePercent: 0,
  };
}

describe('test cards', () => {
  it('are Luhn-valid and unique', () => {
    for (const card of SIMULATED_TEST_CARDS) expect(luhnValid(card.number)).toBe(true);
    expect(new Set(SIMULATED_TEST_CARDS.map((c) => c.number)).size).toBe(
      SIMULATED_TEST_CARDS.length,
    );
  });

  it('accept only allowlisted numbers', () => {
    expect(findTestCard('4242424242424242')?.scenario).toBe('approve');
    expect(findTestCard('4242424242424241')).toBeNull();
    expect(findTestCard(4242424242424242)).toBeNull();
  });
});

describe('SimulatedPaymentProvider (sync)', () => {
  it('describes itself for the browser with the test cards', () => {
    const provider = sync();
    const config = provider.clientConfig() as {
      provider: string;
      resultMode: string;
      testCards: unknown[];
    };
    expect(config.provider).toBe('simulated');
    expect(config.resultMode).toBe('sync');
    expect(config.testCards).toHaveLength(SIMULATED_TEST_CARDS.length);
    expect(provider.capabilities).toMatchObject({
      modificationResults: 'sync',
      shortfall: 'top_up',
      marketplaceSplit: 'none',
      stateLookup: false,
      nativeMobileSheet: false,
    });
  });

  it('creates stable customer and method ids per idempotency key', async () => {
    const provider = sync();
    const a = await provider.createCustomer({
      email: 'a@b.c',
      name: 'A',
      idempotencyKey: 'customer_d1',
    });
    const b = await provider.createCustomer({
      email: 'a@b.c',
      name: 'A',
      idempotencyKey: 'customer_d1',
    });
    expect(a.customerId).toMatch(/^cus_sim_[0-9a-f]{16}$/);
    expect(b).toEqual(a);
    const m1 = await savedMethod(provider, '4242424242424242', 'k');
    const m2 = await savedMethod(provider, '4242424242424242', 'k');
    expect(m1).toEqual(m2);
    expect(m1).toMatchObject({ brand: 'visa', last4: '4242' });
    expect(m1.methodId).toMatch(/^pm_sim_approve_4242_/);
    expect(provider.isUnknownCustomerError()).toBe(false);
  });

  it('starts a setup with the test card descriptor', async () => {
    const session = await sync().startMethodSetup({
      customerId: 'cus_sim_1',
      channel: 'web',
      currency: 'USD',
      countryCode: 'US',
    });
    expect(session).toMatchObject({ provider: 'simulated', customerId: 'cus_sim_1' });
  });

  it('rejects an unknown card without echoing the number', async () => {
    const err = await sync()
      .submitMethodSetup({
        customerId: 'cus_sim_1',
        payload: { testCard: '4000123412341234' },
        idempotencyKey: 'k',
      })
      .then(
        () => new Error('resolved'),
        (e: unknown) => e as Error,
      );
    expect(err).toBeInstanceOf(PaymentValidationError);
    expect(err.message).not.toContain('4000123412341234');
    await expect(
      sync().submitMethodSetup({
        customerId: 'cus_1',
        payload: { testCard: '4242424242424242' },
        idempotencyKey: 'k',
      }),
    ).rejects.toBeInstanceOf(PaymentMethodOwnershipError);
  });

  it('refuses to save the decline cards', async () => {
    const provider = sync();
    for (const [card, reason] of [
      ['4000000000000002', 'card_declined'],
      ['4000000000009995', 'insufficient_funds'],
    ] as const) {
      expect(
        await provider.submitMethodSetup({
          customerId: 'cus_sim_1',
          payload: { testCard: card },
          idempotencyKey: card,
        }),
      ).toEqual({ status: 'refused', reason });
    }
  });

  it('runs the authentication challenge when saving a 3DS card', async () => {
    const provider = sync();
    const step = await provider.submitMethodSetup({
      customerId: 'cus_sim_1',
      payload: { testCard: '4000002500003155' },
      idempotencyKey: 'k',
    });
    expect(step.status).toBe('action_required');
    const methodId = (step as { action: { data: { methodId: string } } }).action.data.methodId;
    expect(
      await provider.continueMethodSetup({
        customerId: 'cus_sim_1',
        details: { methodId, outcome: 'approve' },
        idempotencyKey: 'k2',
      }),
    ).toMatchObject({ status: 'saved', method: { methodId, brand: 'visa', last4: '3155' } });
    expect(
      await provider.continueMethodSetup({
        customerId: 'cus_sim_1',
        details: { methodId, outcome: 'fail' },
        idempotencyKey: 'k3',
      }),
    ).toEqual({ status: 'refused', reason: 'authentication_failed' });
    await expect(
      provider.continueMethodSetup({ customerId: 'cus_sim_1', details: {}, idempotencyKey: 'k4' }),
    ).rejects.toBeInstanceOf(PaymentValidationError);
  });

  it('verifies only simulated methods of simulated customers', async () => {
    const provider = sync();
    expect(
      await provider.verifyMethod({ methodId: 'pm_sim_000001', customerId: 'cus_sim_1' }),
    ).toEqual({
      methodId: 'pm_sim_000001',
      customerId: 'cus_sim_1',
      brand: null,
      last4: null,
    });
    await expect(
      provider.verifyMethod({ methodId: 'pm_1', customerId: 'cus_sim_1' }),
    ).rejects.toBeInstanceOf(PaymentMethodOwnershipError);
    await expect(provider.detachMethod()).resolves.toBeUndefined();
    await expect(provider.testConnection()).resolves.toBeUndefined();
  });

  it('approves, captures and refunds the approve card', async () => {
    const provider = sync();
    const method = await savedMethod(provider, '4242424242424242');
    const held = await provider.authorizeHold(hold(method.methodId));
    expect(held).toMatchObject({ status: 'authorized', authorizedCents: 5000 });
    const paymentId = (held as { paymentId: string }).paymentId;
    expect(parsePaymentId(paymentId)).toEqual({ scenario: 'approve', amountCents: 5000 });
    expect(await provider.authorizeHold(hold(method.methodId))).toEqual(held);
    expect(await provider.capture(captureInput(paymentId))).toEqual({
      state: 'succeeded',
      capturedCents: 3000,
      applicationFeeCents: 0,
    });
    expect(
      await provider.refund({
        idempotencyKey: 'r1',
        paymentId,
        amountCents: 1000,
        currency: 'USD',
        merchantReference: 'sess_s1',
      }),
    ).toMatchObject({ state: 'succeeded', amountCents: 1000 });
    expect(
      await provider.refund({
        idempotencyKey: 'r2',
        paymentId,
        currency: 'USD',
        merchantReference: 'sess_s1',
      }),
    ).toMatchObject({ amountCents: 5000 });
    expect(
      await provider.cancelHold({ paymentId, merchantReference: 'sess_s1', idempotencyKey: 'c1' }),
    ).toEqual({ state: 'succeeded' });
  });

  it('declines at authorization for the decline cards on a one-time method', async () => {
    const provider = sync();
    for (const [card, code] of [
      ['4000000000000002', 'card_declined'],
      ['4000000000009995', 'insufficient_funds'],
    ] as const) {
      const err = await provider
        .authorizeHold({
          ...hold(''),
          method: { kind: 'one_time', payload: { testCard: card } },
          initiator: 'shopper',
        })
        .then(
          () => new PaymentDeclinedError('resolved'),
          (e: unknown) => e as PaymentDeclinedError,
        );
      expect(err).toBeInstanceOf(PaymentDeclinedError);
      expect(err.code).toBe(code);
    }
    await expect(
      provider.authorizeHold({
        ...hold(''),
        method: { kind: 'one_time', payload: { testCard: '1' } },
      }),
    ).rejects.toBeInstanceOf(PaymentValidationError);
    await expect(
      provider.authorizeHold({
        ...hold('pm_sim_000001'),
        method: { kind: 'saved', customerId: 'cus_1', methodId: 'pm_sim_000001' },
      }),
    ).rejects.toBeInstanceOf(PaymentMethodOwnershipError);
  });

  it('saves the 0341 card and declines every charge on it', async () => {
    const provider = sync();
    const method = await savedMethod(provider, '4000000000000341');
    await expect(provider.authorizeHold(hold(method.methodId))).rejects.toBeInstanceOf(
      PaymentDeclinedError,
    );
    await expect(
      provider.chargeSavedMethod({
        idempotencyKey: 'fee',
        customerId: 'cus_sim_1',
        methodId: method.methodId,
        grossCents: 500,
        currency: 'USD',
        feeTaxRate: 0,
        platformFeePercent: 0,
        payoutAccountId: null,
        description: 'fee',
        metadata: {},
      }),
    ).rejects.toBeInstanceOf(PaymentDeclinedError);
  });

  it('challenges a present shopper and declines off session for the 3DS cards', async () => {
    const provider = sync();
    const card = { kind: 'one_time' as const, payload: { testCard: '4917610000000000' } };
    const action = await provider.authorizeHold({
      ...hold(''),
      method: card,
      initiator: 'shopper',
    });
    expect(action.status).toBe('action_required');
    const paymentId = action.paymentId ?? '';
    expect(
      await provider.continueHold({
        paymentId,
        details: { outcome: 'approve' },
        idempotencyKey: 'k',
      }),
    ).toEqual({ status: 'authorized', paymentId, authorizedCents: 5000 });
    await expect(
      provider.continueHold({ paymentId, details: { outcome: 'fail' }, idempotencyKey: 'k' }),
    ).rejects.toBeInstanceOf(PaymentDeclinedError);
    await expect(
      provider.continueHold({ paymentId: null, details: {}, idempotencyKey: 'k' }),
    ).rejects.toBeInstanceOf(PaymentValidationError);

    const err = await provider
      .authorizeHold({ ...hold(''), method: card, initiator: 'merchant' })
      .then(
        () => new PaymentDeclinedError('resolved'),
        (e: unknown) => e as PaymentDeclinedError,
      );
    expect(err.code).toBe('authentication_required');
  });

  it('authorizes half the hold for the partial approval card', async () => {
    const provider = sync();
    const method = await savedMethod(provider, '4000000000000606');
    expect(
      await provider.authorizeHold(hold(method.methodId, { amountCents: 5001 })),
    ).toMatchObject({
      status: 'authorized',
      authorizedCents: 2500,
    });
  });

  it('fails the capture, adjustment and refund on their cards', async () => {
    const provider = sync();
    const paymentFor = async (card: string) => {
      const m = await savedMethod(provider, card, card);
      return (
        (await provider.authorizeHold(hold(m.methodId, { idempotencyKey: card }))) as {
          paymentId: string;
        }
      ).paymentId;
    };
    await expect(
      provider.capture(captureInput(await paymentFor('4000000000000408'))),
    ).rejects.toMatchObject({
      code: 'capture_failed',
    });
    const adj = await paymentFor('4000000000000309');
    await expect(
      provider.adjustHold({
        idempotencyKey: 'a',
        paymentId: adj,
        newTotalCents: 9000,
        currency: 'USD',
      }),
    ).rejects.toMatchObject({ code: 'adjustment_declined' });
    const ok = await paymentFor('4242424242424242');
    expect(
      await provider.adjustHold({
        idempotencyKey: 'a',
        paymentId: ok,
        newTotalCents: 9000,
        currency: 'USD',
      }),
    ).toEqual({ state: 'succeeded', authorizedCents: 9000 });
    await expect(
      provider.refund({
        idempotencyKey: 'r',
        paymentId: await paymentFor('4000000000000507'),
        amountCents: 100,
        currency: 'USD',
        merchantReference: 'm',
      }),
    ).rejects.toMatchObject({ code: 'refund_failed' });
    await expect(provider.capture(captureInput('pi_1'))).rejects.toBeInstanceOf(
      PaymentValidationError,
    );
    await expect(
      provider.refund({
        idempotencyKey: 'r',
        paymentId: 'pi_sim_0123456789abcdef01234567',
        currency: 'USD',
        merchantReference: 'm',
      }),
    ).rejects.toBeInstanceOf(PaymentValidationError);
  });

  it('charges a shortfall on the original card unless that card declines', async () => {
    const provider = sync();
    const ok = await provider.chargeShortfall({
      idempotencyKey: 'topup_1',
      originalPaymentId: 'pi_sim_approve_5000_abc',
      capturedCents: 5000,
      finalCostCents: 6200,
      currency: 'USD',
      feeTax: 0,
      platformFeePercent: 0,
      description: 'd',
    });
    expect(ok).toMatchObject({ amountCents: 1200, applicationFeeCents: 0 });
    await expect(
      provider.chargeShortfall({
        idempotencyKey: 'topup_2',
        originalPaymentId: 'pi_sim_chargefail_5000_abc',
        capturedCents: 5000,
        finalCostCents: 6200,
        currency: 'USD',
        feeTax: 0,
        platformFeePercent: 0,
        description: 'd',
      }),
    ).rejects.toBeInstanceOf(PaymentDeclinedError);
    await expect(
      provider.chargeShortfall({
        idempotencyKey: 'topup_3',
        originalPaymentId: 'pi_sim_approve_5000_abc',
        capturedCents: 5000,
        finalCostCents: 5000,
        currency: 'USD',
        feeTax: 0,
        platformFeePercent: 0,
        description: 'd',
      }),
    ).rejects.toThrow('No shortfall');
  });

  it('fails seeded methods at the random rate, the same way for the same key', async () => {
    const random = vi.fn((key: string) => (key.endsWith('fail') ? 0.1 : 0.9));
    const provider = sync({ random, randomFailureRate: 0.2 });
    const seeded = hold('pm_sim_000001');
    expect((await provider.authorizeHold({ ...seeded, idempotencyKey: 'preauth_ok' })).status).toBe(
      'authorized',
    );
    await expect(
      provider.authorizeHold({ ...seeded, idempotencyKey: 'preauth_fail' }),
    ).rejects.toMatchObject({
      code: 'simulated_failure',
    });
    await expect(
      provider.capture(captureInput('pi_sim_0123456789abcdef01234567', 'capture_fail')),
    ).rejects.toMatchObject({
      code: 'capture_failed',
    });
    expect(
      (await provider.capture(captureInput('pi_sim_0123456789abcdef01234567', 'capture_ok'))).state,
    ).toBe('succeeded');
  });

  it('derives the default random outcome from the key', () => {
    expect(keyFraction('a')).toBe(keyFraction('a'));
    expect(keyFraction('a')).toBeGreaterThanOrEqual(0);
    expect(keyFraction('a')).toBeLessThan(1);
    const failures = Array.from(
      { length: 2000 },
      (_, i) => keyFraction(`k${String(i)}`) < 0.2,
    ).filter(Boolean).length;
    expect(failures).toBeGreaterThan(300);
    expect(failures).toBeLessThan(500);
  });

  it('validates its options', () => {
    expect(() => sync({ randomFailureRate: 2 })).toThrow('between 0 and 1');
    expect(() => sync({ resultMode: 'async' })).toThrow('event sink');
  });
});

describe('SimulatedPaymentProvider (async)', () => {
  it('reports Adyen-like capabilities', () => {
    expect(asyncProvider().provider.capabilities).toMatchObject({
      modificationResults: 'async',
      shortfall: 'adjust_hold',
    });
  });

  it('returns pending modifications and delivers signed events the provider verifies', async () => {
    const { provider, deliveries } = asyncProvider();
    const paymentId = 'pi_sim_approve_5000_abc';
    const capture = await provider.capture(captureInput(paymentId));
    expect(capture).toMatchObject({
      state: 'pending',
      operationRef: expect.stringMatching(/^op_sim_/),
    });
    const cancel = await provider.cancelHold({
      paymentId,
      merchantReference: 'm',
      idempotencyKey: 'c1',
    });
    expect(cancel.state).toBe('pending');
    const refund = await provider.refund({
      idempotencyKey: 'r1',
      paymentId,
      amountCents: 700,
      currency: 'USD',
      merchantReference: 'm',
    });
    expect(refund.state).toBe('pending');
    const adjust = await provider.adjustHold({
      idempotencyKey: 'a1',
      paymentId,
      newTotalCents: 8000,
      currency: 'USD',
    });
    expect(adjust.state).toBe('pending');

    expect(deliveries).toHaveLength(4);
    expect(deliveries.every((d) => d.delaySeconds === 3)).toBe(true);
    const events = deliveries.flatMap((d) => provider.verifyWebhook(d.rawBody, d.headers));
    expect(events.map((e) => e.type)).toEqual([
      'payment.captured',
      'payment.cancelled',
      'payment.refunded',
      'payment.adjusted',
    ]);
    expect(events[0]).toMatchObject({
      paymentId,
      amountCents: 3000,
      operationRef: capture.state === 'pending' ? capture.operationRef : '',
    });
    expect(events[0]?.occurredAt).toBeInstanceOf(Date);
    expect(events[2]).toMatchObject({ amountCents: 700, cumulativeRefundedCents: null });
    expect(events[3]).toMatchObject({ authorizedCents: 8000, success: true });
  });

  it('delivers failures as events for the failure cards', async () => {
    const { provider, deliveries } = asyncProvider();
    await provider.capture(captureInput('pi_sim_capfail_5000_abc'));
    await provider.refund({
      idempotencyKey: 'r',
      paymentId: 'pi_sim_refundfail_5000_abc',
      amountCents: 10,
      currency: 'USD',
      merchantReference: 'm',
    });
    await provider.adjustHold({
      idempotencyKey: 'a',
      paymentId: 'pi_sim_adjfail_5000_abc',
      newTotalCents: 9000,
      currency: 'USD',
    });
    const events = deliveries.flatMap((d) => provider.verifyWebhook(d.rawBody, d.headers));
    expect(events.map((e) => e.type)).toEqual([
      'payment.capture_failed',
      'payment.refund_failed',
      'payment.adjusted',
    ]);
    expect(events[2]).toMatchObject({ success: false });
  });

  it('sends a dispute 30 s after capturing the dispute card', async () => {
    const { provider, deliveries } = asyncProvider();
    await provider.capture(captureInput('pi_sim_dispute_5000_abc'));
    expect(deliveries.map((d) => d.delaySeconds)).toEqual([3, 30]);
    expect(provider.verifyWebhook(deliveries[1]!.rawBody, deliveries[1]!.headers)[0]).toMatchObject(
      {
        type: 'payment.disputed',
        paymentId: 'pi_sim_dispute_5000_abc',
      },
    );
  });

  it('keeps the same event ids for a retried call (dedupe)', async () => {
    const { provider, deliveries } = asyncProvider();
    await provider.capture(captureInput('pi_sim_approve_5000_abc', 'capture_9'));
    await provider.capture(captureInput('pi_sim_approve_5000_abc', 'capture_9'));
    const [a, b] = deliveries.map((d) => provider.verifyWebhook(d.rawBody, d.headers)[0]?.eventId);
    expect(a).toBe(b);
  });

  it('logs and still succeeds when the sink fails', async () => {
    const warn = vi.fn();
    const provider = new SimulatedPaymentProvider({
      encryptionKey: KEY,
      resultMode: 'async',
      events: { deliver: () => Promise.reject(new Error('redis down')) },
      logger: { warn },
    });
    expect((await provider.capture(captureInput('pi_sim_approve_5000_abc'))).state).toBe('pending');
    expect(warn).toHaveBeenCalledWith(
      expect.objectContaining({ eventIds: expect.any(Array) }),
      expect.any(String),
    );
  });

  it('cancels a hold without a payment id at once', async () => {
    const { provider, deliveries } = asyncProvider();
    expect(
      await provider.cancelHold({ paymentId: null, merchantReference: 'm', idempotencyKey: 'c' }),
    ).toEqual({
      state: 'succeeded',
    });
    expect(deliveries).toHaveLength(0);
  });
});

describe('simulated webhooks', () => {
  it('rejects a missing or wrong signature', () => {
    const provider = sync();
    const signed = signSimulatedWebhook([], KEY);
    expect(provider.verifyWebhook(signed.rawBody, signed.headers)).toEqual([]);
    expect(() => provider.verifyWebhook(signed.rawBody, {})).toThrow(WebhookSignatureError);
    const other = signSimulatedWebhook([], 'another-key-32-characters-long!!');
    expect(() => provider.verifyWebhook(signed.rawBody, other.headers)).toThrow(
      WebhookSignatureError,
    );
    expect(() => provider.verifyWebhook(signed.rawBody, { 'x-simulated-signature': 'zz' })).toThrow(
      WebhookSignatureError,
    );
    expect(provider.webhookAck().status).toBe(200);
    expect(provider.webhookPath).toBe('payments/simulated');
  });

  it('rejects a correctly signed body without an events array', () => {
    const provider = sync();
    const body = '{"nope":true}';
    const signature = crypto
      .createHmac('sha256', simulatedWebhookKey(KEY))
      .update(body)
      .digest('hex');
    expect(() => provider.verifyWebhook(body, { 'x-simulated-signature': signature })).toThrow(
      'no events array',
    );
  });
});

describe('simulatedProviderFactory', () => {
  it('always builds the same configured provider', async () => {
    const factory = simulatedProviderFactory({ encryptionKey: KEY });
    const settings = {
      provider: 'simulated',
      preAuthAmountCents: 5000,
      stripe: { secretKey: null, publishableKey: null, webhookSecret: null },
      adyen: emptyAdyenSettings(),
    };
    const a = await factory.create(settings);
    expect(a?.id).toBe('simulated');
    expect(await factory.create(settings)).toBe(a);
  });
});
