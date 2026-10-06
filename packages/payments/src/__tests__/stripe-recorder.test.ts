// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { describe, it, expect, beforeEach } from 'vitest';
import {
  FakeStripeError,
  fakeStripeModule,
  fakeStripeSignature,
  goldenJson,
  normalizeGolden,
  stripeRecorder,
} from '../testing/index.js';

const FakeStripe = fakeStripeModule().default;

function stripe(): InstanceType<typeof FakeStripe> {
  return new FakeStripe();
}

async function rejection(p: Promise<unknown>): Promise<FakeStripeError> {
  const err = await p.then(
    () => null,
    (e: unknown) => e,
  );
  expect(err).toBeInstanceOf(FakeStripeError);
  return err as FakeStripeError;
}

describe('stripe recorder fake', () => {
  beforeEach(() => {
    stripeRecorder.reset();
  });

  describe('paymentIntents.create', () => {
    it('creates a manual hold keyed by the idempotency key and records the call', async () => {
      const s = stripe();
      const params = {
        amount: 2500,
        currency: 'usd',
        customer: 'cus_1',
        payment_method: 'pm_1',
        capture_method: 'manual',
        on_behalf_of: 'acct_1',
        transfer_data: { destination: 'acct_1' },
        application_fee_amount: 100,
      };
      const intent = await s.paymentIntents.create(params, { idempotencyKey: 'preauth_x' });

      expect(intent).toMatchObject({
        id: 'pi_preauth_x',
        status: 'requires_capture',
        amount_capturable: 2500,
        amount_received: 0,
        capture_method: 'manual',
        on_behalf_of: 'acct_1',
        transfer_data: { destination: 'acct_1' },
        application_fee_amount: 100,
        client_secret: 'pi_preauth_x_secret',
      });
      expect(stripeRecorder.calls).toEqual([
        {
          call: 'paymentIntents.create',
          args: [params],
          options: { idempotencyKey: 'preauth_x' },
        },
      ]);
    });

    it('replays the first intent for a repeated idempotency key', async () => {
      const s = stripe();
      const first = await s.paymentIntents.create(
        { amount: 100, currency: 'usd', capture_method: 'manual' },
        { idempotencyKey: 'k' },
      );
      const second = await s.paymentIntents.create(
        { amount: 999, currency: 'usd', capture_method: 'manual' },
        { idempotencyKey: 'k' },
      );
      expect(second).toBe(first);
      expect(second.amount).toBe(100);
      expect(stripeRecorder.calls).toHaveLength(2);
    });

    it('charges immediately without manual capture and numbers ids without a key', async () => {
      const s = stripe();
      const a = await s.paymentIntents.create({ amount: 700, currency: 'eur' });
      const b = await s.paymentIntents.create({ amount: 800, currency: 'eur' });
      expect(a).toMatchObject({
        id: 'pi_auto_1',
        status: 'succeeded',
        amount_received: 700,
        amount_capturable: 0,
        capture_method: 'automatic',
        customer: null,
        payment_method: null,
        on_behalf_of: null,
        transfer_data: null,
        application_fee_amount: null,
      });
      expect(b.id).toBe('pi_auto_2');
      expect(stripeRecorder.calls[0]?.options).toBeUndefined();
    });

    it('declines a decline-listed method', async () => {
      stripeRecorder.declineMethods.add('pm_bad');
      const err = await rejection(
        stripe().paymentIntents.create({ amount: 1, currency: 'usd', payment_method: 'pm_bad' }),
      );
      expect(err.type).toBe('StripeCardError');
      expect(err.code).toBe('card_declined');
      expect(err.decline_code).toBe('generic_decline');
      expect(err.statusCode).toBe(402);
      expect(stripeRecorder.intents.size).toBe(0);
    });

    it('holds a charge-fail method but declines an immediate charge on it', async () => {
      stripeRecorder.chargeFailMethods.add('pm_cf');
      const s = stripe();
      await expect(
        s.paymentIntents.create({
          amount: 1,
          currency: 'usd',
          payment_method: 'pm_cf',
          capture_method: 'manual',
        }),
      ).resolves.toMatchObject({ status: 'requires_capture' });
      const err = await rejection(
        s.paymentIntents.create({ amount: 1, currency: 'usd', payment_method: 'pm_cf' }),
      );
      expect(err.code).toBe('card_declined');
    });

    it('needs authentication for a 3DS method on session and fails it off session', async () => {
      stripeRecorder.actionMethods.add('pm_3ds');
      const s = stripe();
      await expect(
        s.paymentIntents.create({ amount: 5, currency: 'usd', payment_method: 'pm_3ds' }),
      ).resolves.toMatchObject({ status: 'requires_action', amount_received: 0 });
      const err = await rejection(
        s.paymentIntents.create({
          amount: 5,
          currency: 'usd',
          payment_method: 'pm_3ds',
          off_session: true,
        }),
      );
      expect(err.code).toBe('authentication_required');
      expect(err.decline_code).toBe('authentication_required');
    });
  });

  describe('paymentIntents.retrieve, capture and cancel', () => {
    it('retrieves a seeded intent with defaults', async () => {
      const seeded = stripeRecorder.seedIntent('pi_seed', { amount: 1200 });
      expect(seeded).toMatchObject({
        status: 'requires_capture',
        customer: 'cus_seeded',
        payment_method: 'pm_seeded',
        client_secret: 'pi_seed_secret',
      });
      await expect(stripe().paymentIntents.retrieve('pi_seed')).resolves.toMatchObject({
        amount: 1200,
      });
      expect(stripeRecorder.calls).toEqual([
        { call: 'paymentIntents.retrieve', args: ['pi_seed'] },
      ]);
    });

    it('fails retrieve for an unknown intent with resource_missing', async () => {
      const err = await rejection(stripe().paymentIntents.retrieve('pi_none'));
      expect(err.type).toBe('StripeInvalidRequestError');
      expect(err.code).toBe('resource_missing');
      expect(err.statusCode).toBe(404);
      expect(err.message).toContain("'pi_none'");
    });

    it('fails retrieve with a connection error when told to', async () => {
      stripeRecorder.seedIntent('pi_net');
      stripeRecorder.retrieveFailIntents.add('pi_net');
      const err = await rejection(stripe().paymentIntents.retrieve('pi_net'));
      expect(err.type).toBe('StripeConnectionError');
      expect(err.statusCode).toBe(500);
    });

    it('captures a partial amount and the application fee', async () => {
      stripeRecorder.seedIntent('pi_c', { amount: 5000, amount_capturable: 5000 });
      const out = await stripe().paymentIntents.capture(
        'pi_c',
        { amount_to_capture: 3100, application_fee_amount: 50 },
        { idempotencyKey: 'capture_pi_c' },
      );
      expect(out).toMatchObject({
        status: 'succeeded',
        amount_received: 3100,
        amount_capturable: 0,
        application_fee_amount: 50,
      });
      expect(stripeRecorder.calls[0]).toEqual({
        call: 'paymentIntents.capture',
        args: ['pi_c', { amount_to_capture: 3100, application_fee_amount: 50 }],
        options: { idempotencyKey: 'capture_pi_c' },
      });
    });

    it('captures the full amount when no amount is given', async () => {
      stripeRecorder.seedIntent('pi_full', { amount: 4200 });
      const out = await stripe().paymentIntents.capture('pi_full', {});
      expect(out.amount_received).toBe(4200);
      expect(out.application_fee_amount).toBeNull();
    });

    it('refuses to capture a capture-fail intent or one not awaiting capture', async () => {
      stripeRecorder.seedIntent('pi_cf');
      stripeRecorder.captureFailIntents.add('pi_cf');
      const a = await rejection(stripe().paymentIntents.capture('pi_cf', {}));
      expect(a.code).toBe('payment_intent_unexpected_state');
      expect(a.message).toContain('status of canceled');

      stripeRecorder.seedIntent('pi_done', { status: 'succeeded' });
      const b = await rejection(stripe().paymentIntents.capture('pi_done', {}));
      expect(b.message).toContain('status of succeeded');
      expect(b.statusCode).toBe(400);
    });

    it('cancels a hold and records params only when given', async () => {
      stripeRecorder.seedIntent('pi_x');
      stripeRecorder.seedIntent('pi_y');
      const s = stripe();
      await expect(s.paymentIntents.cancel('pi_x')).resolves.toMatchObject({
        status: 'canceled',
        amount_capturable: 0,
      });
      await s.paymentIntents.cancel(
        'pi_y',
        { cancellation_reason: 'abandoned' },
        { idempotencyKey: 'cancel_y' },
      );
      expect(stripeRecorder.calls).toEqual([
        { call: 'paymentIntents.cancel', args: ['pi_x'] },
        {
          call: 'paymentIntents.cancel',
          args: ['pi_y', { cancellation_reason: 'abandoned' }],
          options: { idempotencyKey: 'cancel_y' },
        },
      ]);
    });

    it('refuses to cancel a succeeded or canceled intent', async () => {
      stripeRecorder.seedIntent('pi_s', { status: 'succeeded' });
      stripeRecorder.seedIntent('pi_k', { status: 'canceled' });
      const s = stripe();
      expect((await rejection(s.paymentIntents.cancel('pi_s'))).message).toContain('succeeded');
      expect((await rejection(s.paymentIntents.cancel('pi_k'))).message).toContain('canceled');
    });
  });

  describe('refunds.create', () => {
    it('refunds up to the received amount, keyed by the idempotency key', async () => {
      stripeRecorder.seedIntent('pi_r', { status: 'succeeded', amount_received: 3000 });
      const s = stripe();
      await expect(
        s.refunds.create({ payment_intent: 'pi_r', amount: 1000 }, { idempotencyKey: 'ref_1' }),
      ).resolves.toEqual({
        id: 're_ref_1',
        object: 'refund',
        amount: 1000,
        payment_intent: 'pi_r',
        status: 'succeeded',
      });
      await expect(s.refunds.create({ payment_intent: 'pi_r' })).resolves.toMatchObject({
        id: 're_nokey',
        amount: 3000,
      });
    });

    it('refuses a refund above the received amount', async () => {
      stripeRecorder.seedIntent('pi_r2', { status: 'succeeded', amount_received: 500 });
      const err = await rejection(
        stripe().refunds.create({ payment_intent: 'pi_r2', amount: 501 }),
      );
      expect(err.code).toBe('amount_too_large');
      expect(err.message).toBe('Refund amount (501) is greater than charge amount (500)');
    });
  });

  describe('customers, setup intents, keys and methods', () => {
    it('creates setup intents for known customers and refuses stale ones', async () => {
      const s = stripe();
      await expect(s.setupIntents.create({ customer: 'cus_ok' })).resolves.toEqual({
        id: 'seti_1',
        object: 'setup_intent',
        client_secret: 'seti_1_secret_x',
        customer: 'cus_ok',
      });
      stripeRecorder.staleCustomers.add('cus_gone');
      const err = await rejection(s.setupIntents.create({ customer: 'cus_gone' }));
      expect(err.code).toBe('resource_missing');
      expect(err.statusCode).toBe(400);
    });

    it('creates customers and ephemeral keys and records them', async () => {
      const s = stripe();
      await expect(s.customers.create({ email: 'a@b.c' })).resolves.toEqual({
        id: 'cus_new_1',
        object: 'customer',
      });
      await expect(
        s.ephemeralKeys.create({ customer: 'cus_new_1' }, { apiVersion: '2025-01-01' }),
      ).resolves.toEqual({ id: 'ephkey_1', secret: 'ek_test_secret' });
      await expect(s.balance.retrieve()).resolves.toMatchObject({ object: 'balance' });
      expect(stripeRecorder.calls.map((c) => c.call)).toEqual([
        'customers.create',
        'ephemeralKeys.create',
        'balance.retrieve',
      ]);
      expect(stripeRecorder.calls[1]?.options).toEqual({ apiVersion: '2025-01-01' });
    });

    it('retrieves seeded payment methods, fails unknown ones, and detaches', async () => {
      stripeRecorder.seedPaymentMethod('pm_card', 'cus_1');
      stripeRecorder.seedPaymentMethod('pm_amex', null, '0005', 'amex');
      const s = stripe();
      await expect(s.paymentMethods.retrieve('pm_card')).resolves.toEqual({
        id: 'pm_card',
        object: 'payment_method',
        customer: 'cus_1',
        card: { brand: 'visa', last4: '4242' },
      });
      await expect(s.paymentMethods.retrieve('pm_amex')).resolves.toMatchObject({
        card: { brand: 'amex', last4: '0005' },
      });
      const err = await rejection(s.paymentMethods.retrieve('pm_none'));
      expect(err.statusCode).toBe(404);
      await expect(s.paymentMethods.detach('pm_card')).resolves.toEqual({
        id: 'pm_card',
        object: 'payment_method',
        customer: null,
      });
    });
  });

  describe('webhook endpoints', () => {
    it('fails deleting an unknown endpoint', async () => {
      const err = await rejection(stripe().webhookEndpoints.del('we_missing'));
      expect(err.code).toBe('resource_missing');
      expect(err.statusCode).toBe(404);
    });

    it('verifies webhook signatures', () => {
      const s = stripe();
      const sig = fakeStripeSignature('whsec_1');
      expect(sig).toBe('t=1,v1=whsec_1');
      expect(s.webhooks.constructEvent('{"id":"evt_1"}', sig, 'whsec_1')).toEqual({ id: 'evt_1' });
      let thrown: unknown;
      try {
        s.webhooks.constructEvent('{}', 't=1,v1=other', 'whsec_1');
      } catch (e) {
        thrown = e;
      }
      expect(thrown).toBeInstanceOf(FakeStripeError);
      expect((thrown as FakeStripeError).type).toBe('StripeSignatureVerificationError');
      expect(stripeRecorder.calls).toEqual([]);
    });
  });

  it('records a deep copy of the arguments', async () => {
    const params = { amount: 1, currency: 'usd', metadata: { a: '1' } };
    await stripe().paymentIntents.create(params);
    params.metadata.a = 'changed';
    expect(stripeRecorder.calls[0]?.args[0]).toEqual({
      amount: 1,
      currency: 'usd',
      metadata: { a: '1' },
    });
  });

  it('reset clears calls, seeds and id counters', async () => {
    stripeRecorder.seedIntent('pi_1');
    stripeRecorder.declineMethods.add('pm_x');
    await stripe().customers.create({});
    stripeRecorder.reset();
    expect(stripeRecorder.calls).toEqual([]);
    expect(stripeRecorder.intents.size).toBe(0);
    expect(stripeRecorder.declineMethods.size).toBe(0);
    await expect(stripe().customers.create({})).resolves.toMatchObject({ id: 'cus_new_1' });
  });
});

describe('normalizeGolden', () => {
  it('replaces generated ids with placeholders numbered by first appearance', () => {
    const out = normalizeGolden({
      a: 'ses_abcdefghijkl',
      b: 'preauth_ses_abcdefghijkl',
      c: 'ses_000000000001',
      d: 'drv_aaaaaaaaaaaa',
    });
    expect(out).toEqual({
      a: '<ses:1>',
      b: 'preauth_<ses:1>',
      c: '<ses:2>',
      d: '<drv:1>',
    });
  });

  it('leaves ids embedded in longer tokens alone', () => {
    expect(normalizeGolden({ v: 'xses_abcdefghijkl', w: 'ses_abcdefghijklm' })).toEqual({
      v: 'xses_abcdefghijkl',
      w: 'ses_abcdefghijklm',
    });
  });

  it('replaces guest checkout tokens and applies aliases first', () => {
    const out = normalizeGolden(
      {
        key: 'guest_preauth_0123456789abcdef0123',
        again: 'pi_guest_preauth_0123456789abcdef0123',
        uuid: '7c9e6679-7425-40de-944b-e07fc1f90ae7',
      },
      { '7c9e6679-7425-40de-944b-e07fc1f90ae7': '<uuid>' },
    );
    expect(out).toEqual({
      key: 'guest_preauth_<guestToken:1>',
      again: 'pi_guest_preauth_<guestToken:1>',
      uuid: '<uuid>',
    });
  });

  it('sorts object keys recursively, keeps array order, and serializes dates', () => {
    const out = normalizeGolden({
      z: 1,
      a: [{ y: 2, b: 1 }, 3],
      d: new Date('2026-01-01T00:00:00Z'),
    });
    expect(JSON.stringify(out)).toBe(
      '{"a":[{"b":1,"y":2},3],"d":"2026-01-01T00:00:00.000Z","z":1}',
    );
  });

  it('goldenJson writes stable pretty JSON with a trailing newline', () => {
    expect(goldenJson({ b: 1, a: 'usr_abcdefghijkl' })).toBe('{\n  "a": "<usr:1>",\n  "b": 1\n}\n');
  });
});
