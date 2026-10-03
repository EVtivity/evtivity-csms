// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { describe, it, expect, vi } from 'vitest';
import Stripe from 'stripe';

vi.mock('@evtivity/database', () => ({ db: {}, settings: {}, sitePaymentConfigs: {} }));

import { StripePaymentProvider, stripeProviderFactory } from '../providers/stripe/index.js';
import {
  PaymentDeclinedError,
  PaymentMethodOwnershipError,
  PaymentOperationNotSupportedError,
  PaymentProviderUnavailableError,
  PaymentValidationError,
  WebhookNotConfiguredError,
  WebhookSignatureError,
} from '../errors.js';
import type { AuthorizeHoldInput } from '../types.js';
import { fakeClient, realStripe } from './helpers/fake-stripe.js';
import { emptyAdyenSettings } from './helpers/settings.js';

function provider(client = fakeClient(), webhookSecret: string | null = 'whsec_test') {
  return {
    client,
    stripe: new StripePaymentProvider({
      client: client as unknown as Stripe,
      publishableKey: 'pk_test_1',
      webhookSecret,
    }),
  };
}

const savedHold: AuthorizeHoldInput = {
  idempotencyKey: 'preauth_sess-1',
  method: { kind: 'saved', customerId: 'cus_1', methodId: 'pm_1' },
  initiator: 'merchant',
  merchantReference: 'sess_sess-1',
  amountCents: 5000,
  currency: 'EUR',
  payoutAccountId: null,
};

function stripeError(type: string, message: string, extra: Record<string, unknown> = {}) {
  return Object.assign(new Error(message), { type, ...extra });
}

describe('StripePaymentProvider', () => {
  it('has Stripe capabilities and a browser config with the publishable key', () => {
    const { stripe } = provider();
    expect(stripe.capabilities).toMatchObject({
      shortfall: 'top_up',
      modificationResults: 'sync',
      marketplaceSplit: 'destination_charge',
      stateLookup: true,
    });
    expect(stripe.clientConfig()).toEqual({ provider: 'stripe', publishableKey: 'pk_test_1' });
    expect(stripe.webhookPath).toBe('payments/stripe');
  });

  it('tests the connection with balance.retrieve', async () => {
    const { client, stripe } = provider();
    await stripe.testConnection();
    expect(client.balance.retrieve).toHaveBeenCalled();
  });

  describe('authorizeHold', () => {
    it('places an off-session manual-capture hold, as createPreAuthorization does', async () => {
      const { client, stripe } = provider();
      const result = await stripe.authorizeHold(savedHold);
      expect(client.paymentIntents.create).toHaveBeenCalledWith(
        {
          amount: 5000,
          currency: 'eur',
          customer: 'cus_1',
          payment_method: 'pm_1',
          capture_method: 'manual',
          confirm: true,
          off_session: true,
        },
        { idempotencyKey: 'preauth_sess-1' },
      );
      expect(result).toEqual({ status: 'authorized', paymentId: 'pi_1', authorizedCents: 5000 });
    });

    it('makes a destination charge without a fee for a site with a connected account', async () => {
      const { client, stripe } = provider();
      await stripe.authorizeHold({ ...savedHold, payoutAccountId: 'acct_1' });
      expect(client.paymentIntents.create.mock.calls[0]?.[0]).toMatchObject({
        on_behalf_of: 'acct_1',
        transfer_data: { destination: 'acct_1' },
      });
      expect(client.paymentIntents.create.mock.calls[0]?.[0]).not.toHaveProperty(
        'application_fee_amount',
      );
    });

    it('places a guest hold on a one-time method, as the guest start does', async () => {
      const { client, stripe } = provider();
      await stripe.authorizeHold({
        idempotencyKey: 'guest_preauth_tok',
        method: { kind: 'one_time', payload: 'pm_guest' },
        initiator: 'shopper',
        merchantReference: 'guest_tok',
        amountCents: 2500,
        currency: 'USD',
        payoutAccountId: 'acct_2',
        receiptEmail: 'guest@example.com',
      });
      expect(client.paymentIntents.create).toHaveBeenCalledWith(
        {
          amount: 2500,
          currency: 'usd',
          payment_method: 'pm_guest',
          capture_method: 'manual',
          confirm: true,
          automatic_payment_methods: { enabled: true, allow_redirects: 'never' },
          receipt_email: 'guest@example.com',
          on_behalf_of: 'acct_2',
          transfer_data: { destination: 'acct_2' },
        },
        { idempotencyKey: 'guest_preauth_tok' },
      );
    });

    it('confirms on session without redirects when the shopper is present and returns the action', async () => {
      const { client, stripe } = provider();
      client.paymentIntents.create.mockResolvedValueOnce({
        id: 'pi_2',
        status: 'requires_action',
        client_secret: 'pi_2_secret',
        amount: 5000,
        amount_capturable: 0,
      });
      const result = await stripe.authorizeHold({ ...savedHold, initiator: 'shopper' });
      expect(client.paymentIntents.create.mock.calls[0]?.[0]).not.toHaveProperty('off_session');
      expect(client.paymentIntents.create.mock.calls[0]?.[0]).toMatchObject({
        automatic_payment_methods: { enabled: true, allow_redirects: 'never' },
      });
      expect(result).toEqual({
        status: 'action_required',
        paymentId: 'pi_2',
        action: { provider: 'stripe', data: { clientSecret: 'pi_2_secret' } },
      });
    });

    it('passes description, metadata and receipt email only when given', async () => {
      const { client, stripe } = provider();
      await stripe.authorizeHold({
        ...savedHold,
        description: 'Charging',
        metadata: { sessionId: 's1' },
      });
      expect(client.paymentIntents.create.mock.calls[0]?.[0]).toMatchObject({
        description: 'Charging',
        metadata: { sessionId: 's1' },
      });
    });

    it('turns a card error into PaymentDeclinedError with the Stripe message', async () => {
      const { client, stripe } = provider();
      client.paymentIntents.create.mockRejectedValueOnce(
        stripeError('StripeCardError', 'Your card has insufficient funds.', {
          code: 'card_declined',
          decline_code: 'insufficient_funds',
        }),
      );
      const err = await stripe.authorizeHold(savedHold).catch((e: unknown) => e);
      expect(err).toBeInstanceOf(PaymentDeclinedError);
      expect((err as PaymentDeclinedError).message).toBe('Your card has insufficient funds.');
      expect((err as PaymentDeclinedError).code).toBe('insufficient_funds');
    });

    it('turns an outage into PaymentProviderUnavailableError and rethrows other errors', async () => {
      const { client, stripe } = provider();
      client.paymentIntents.create.mockRejectedValueOnce(
        stripeError('StripeConnectionError', 'socket hang up'),
      );
      await expect(stripe.authorizeHold(savedHold)).rejects.toBeInstanceOf(
        PaymentProviderUnavailableError,
      );
      const invalid = stripeError('StripeInvalidRequestError', 'No such customer');
      client.paymentIntents.create.mockRejectedValueOnce(invalid);
      await expect(stripe.authorizeHold(savedHold)).rejects.toBe(invalid);
      client.paymentIntents.create.mockRejectedValueOnce('plain string');
      await expect(stripe.authorizeHold(savedHold)).rejects.toBe('plain string');
    });

    it('declines an intent that needs a new payment method', async () => {
      const { client, stripe } = provider();
      client.paymentIntents.create.mockResolvedValueOnce({
        id: 'pi_3',
        status: 'requires_payment_method',
        last_payment_error: { message: 'Declined', code: 'card_declined' },
      });
      await expect(stripe.authorizeHold(savedHold)).rejects.toThrow('Declined');
    });

    it('refuses a one-time method that is not a PaymentMethod id', async () => {
      const { stripe } = provider();
      await expect(
        stripe.authorizeHold({ ...savedHold, method: { kind: 'one_time', payload: { x: 1 } } }),
      ).rejects.toBeInstanceOf(PaymentValidationError);
    });
  });

  it('continues a hold by reading the intent after the client action', async () => {
    const { client, stripe } = provider();
    client.paymentIntents.retrieve.mockResolvedValueOnce({
      id: 'pi_1',
      status: 'requires_capture',
      amount: 5000,
      amount_capturable: 5000,
    });
    expect(
      await stripe.continueHold({ paymentId: 'pi_1', details: null, idempotencyKey: 'k' }),
    ).toEqual({ status: 'authorized', paymentId: 'pi_1', authorizedCents: 5000 });
    await expect(
      stripe.continueHold({ paymentId: null, details: null, idempotencyKey: 'k' }),
    ).rejects.toBeInstanceOf(PaymentValidationError);
  });

  describe('capture', () => {
    const capture = {
      idempotencyKey: 'capture_7',
      paymentId: 'pi_1',
      amountCents: 1190,
      currency: 'EUR',
      merchantReference: 'sess_1',
      payoutAccountId: null,
      feeTax: 0.19,
      platformFeePercent: 10,
    };

    it('captures without a fee when the intent has no destination', async () => {
      const { client, stripe } = provider();
      const result = await stripe.capture(capture);
      expect(client.paymentIntents.capture).toHaveBeenCalledWith(
        'pi_1',
        { amount_to_capture: 1190 },
        { idempotencyKey: 'capture_7' },
      );
      expect(result).toEqual({ state: 'succeeded', capturedCents: 1190, applicationFeeCents: 0 });
    });

    it('takes the platform fee of the net amount on a destination charge', async () => {
      const { client, stripe } = provider();
      client.paymentIntents.retrieve.mockResolvedValueOnce({
        customer: 'cus_1',
        payment_method: 'pm_1',
        transfer_data: { destination: 'acct_1' },
      });
      const result = await stripe.capture(capture);
      expect(client.paymentIntents.capture).toHaveBeenCalledWith(
        'pi_1',
        { amount_to_capture: 1190, application_fee_amount: 100 },
        { idempotencyKey: 'capture_7' },
      );
      expect(result).toMatchObject({ applicationFeeCents: 100 });
    });

    it('does not read the intent without a fee percent', async () => {
      const { client, stripe } = provider();
      await stripe.capture({ ...capture, platformFeePercent: 0 });
      expect(client.paymentIntents.retrieve).not.toHaveBeenCalled();
    });
  });

  it('charges a shortfall on the original card and destination, as chargeShortfallTopUp does', async () => {
    const { client, stripe } = provider();
    client.paymentIntents.retrieve.mockResolvedValueOnce({
      customer: 'cus_1',
      payment_method: 'pm_1',
      transfer_data: { destination: 'acct_1' },
      on_behalf_of: 'acct_1',
    });
    client.paymentIntents.create.mockResolvedValueOnce({ id: 'pi_top' });
    const result = await stripe.chargeShortfall({
      idempotencyKey: 'topup_7',
      originalPaymentId: 'pi_1',
      capturedCents: 5000,
      finalCostCents: 5950,
      currency: 'EUR',
      feeTax: 0.19,
      platformFeePercent: 10,
      description: 'Charging session shortfall',
    });
    expect(client.paymentIntents.create).toHaveBeenCalledWith(
      {
        amount: 950,
        currency: 'eur',
        customer: 'cus_1',
        payment_method: 'pm_1',
        confirm: true,
        off_session: true,
        capture_method: 'automatic',
        description: 'Charging session shortfall',
        on_behalf_of: 'acct_1',
        transfer_data: { destination: 'acct_1' },
        application_fee_amount: 80,
      },
      { idempotencyKey: 'topup_7' },
    );
    expect(result).toEqual({ paymentId: 'pi_top', amountCents: 950, applicationFeeCents: 80 });
  });

  it('charges a saved card immediately with the fee on its net amount, as chargeSavedCard does', async () => {
    const { client, stripe } = provider();
    client.paymentIntents.create.mockResolvedValueOnce({ id: 'pi_fee', status: 'succeeded' });
    const result = await stripe.chargeSavedMethod({
      idempotencyKey: 'cancellation-fee-r1',
      customerId: 'cus_1',
      methodId: 'pm_1',
      grossCents: 1190,
      currency: 'EUR',
      feeTaxRate: 0.19,
      platformFeePercent: 10,
      payoutAccountId: 'acct_1',
      description: 'Reservation cancellation fee',
      metadata: { reservationId: 'r1', type: 'reservation_cancellation_fee' },
    });
    expect(client.paymentIntents.create).toHaveBeenCalledWith(
      {
        amount: 1190,
        currency: 'eur',
        customer: 'cus_1',
        payment_method: 'pm_1',
        confirm: true,
        off_session: true,
        description: 'Reservation cancellation fee',
        metadata: { reservationId: 'r1', type: 'reservation_cancellation_fee' },
        on_behalf_of: 'acct_1',
        transfer_data: { destination: 'acct_1' },
        application_fee_amount: 100,
      },
      { idempotencyKey: 'cancellation-fee-r1' },
    );
    expect(result).toEqual({ paymentId: 'pi_fee', amountCents: 1190, applicationFeeCents: 100 });
  });

  it('declines an immediate charge that needs authentication', async () => {
    const { client, stripe } = provider();
    client.paymentIntents.create.mockResolvedValueOnce({ id: 'pi_x', status: 'requires_action' });
    await expect(
      stripe.chargeSavedMethod({
        idempotencyKey: 'k',
        customerId: 'cus_1',
        methodId: 'pm_1',
        grossCents: 100,
        currency: 'USD',
        feeTaxRate: 0,
        platformFeePercent: 0,
        payoutAccountId: null,
        description: 'd',
        metadata: {},
      }),
    ).rejects.toBeInstanceOf(PaymentDeclinedError);
  });

  it('cancels a hold by id with the idempotency key', async () => {
    const { client, stripe } = provider();
    expect(
      await stripe.cancelHold({
        paymentId: 'pi_1',
        merchantReference: 'sess_1',
        idempotencyKey: 'cancel_7',
      }),
    ).toEqual({ state: 'succeeded' });
    expect(client.paymentIntents.cancel).toHaveBeenCalledWith(
      'pi_1',
      {},
      { idempotencyKey: 'cancel_7' },
    );
    await expect(
      stripe.cancelHold({ paymentId: null, merchantReference: 'sess_1', idempotencyKey: 'c' }),
    ).rejects.toBeInstanceOf(PaymentValidationError);
  });

  it('refunds a destination charge with the Connect reversal flags, as createRefund does', async () => {
    const { client, stripe } = provider();
    client.paymentIntents.retrieve.mockResolvedValueOnce({
      transfer_data: { destination: 'acct_1' },
      application_fee_amount: 100,
    });
    const result = await stripe.refund({
      idempotencyKey: 'refund_pi_1_7_0_700',
      paymentId: 'pi_1',
      amountCents: 700,
      currency: 'EUR',
      merchantReference: 'sess_1',
    });
    expect(client.refunds.create).toHaveBeenCalledWith(
      { payment_intent: 'pi_1', amount: 700, reverse_transfer: true, refund_application_fee: true },
      { idempotencyKey: 'refund_pi_1_7_0_700' },
    );
    expect(result).toEqual({ state: 'succeeded', refundId: 're_1', amountCents: 700 });
  });

  it('refunds a plain charge in full without flags', async () => {
    const { client, stripe } = provider();
    await stripe.refund({
      idempotencyKey: 'k',
      paymentId: 'pi_1',
      currency: 'EUR',
      merchantReference: 'sess_1',
    });
    expect(client.refunds.create).toHaveBeenCalledWith(
      { payment_intent: 'pi_1' },
      { idempotencyKey: 'k' },
    );
  });

  it('reverses the transfer of a destination charge without a fee and refunds a partial amount', async () => {
    const { client, stripe } = provider();
    client.paymentIntents.retrieve.mockResolvedValueOnce({
      transfer_data: { destination: 'acct_1' },
      application_fee_amount: null,
    });
    await stripe.refund({
      idempotencyKey: 'k2',
      paymentId: 'pi_1',
      amountCents: 300,
      currency: 'EUR',
      merchantReference: 'sess_1',
    });
    expect(client.refunds.create).toHaveBeenCalledWith(
      { payment_intent: 'pi_1', amount: 300, reverse_transfer: true },
      { idempotencyKey: 'k2' },
    );
  });

  it('charges a saved card on the platform account without a destination or fee', async () => {
    const { client, stripe } = provider();
    client.paymentIntents.create.mockResolvedValueOnce({ id: 'pi_fee', status: 'succeeded' });
    const result = await stripe.chargeSavedMethod({
      idempotencyKey: 'no-show-fee-r2',
      customerId: 'cus_1',
      methodId: 'pm_1',
      grossCents: 1190,
      currency: 'EUR',
      feeTaxRate: 0.19,
      platformFeePercent: 10,
      payoutAccountId: null,
      description: 'Reservation no-show fee',
      metadata: { reservationId: 'r2', type: 'reservation_no_show_fee' },
    });
    expect(client.paymentIntents.create).toHaveBeenCalledWith(
      {
        amount: 1190,
        currency: 'eur',
        customer: 'cus_1',
        payment_method: 'pm_1',
        confirm: true,
        off_session: true,
        description: 'Reservation no-show fee',
        metadata: { reservationId: 'r2', type: 'reservation_no_show_fee' },
      },
      { idempotencyKey: 'no-show-fee-r2' },
    );
    expect(result).toEqual({ paymentId: 'pi_fee', amountCents: 1190, applicationFeeCents: 0 });
  });

  describe('methods', () => {
    it('creates a customer with the idempotency key', async () => {
      const { client, stripe } = provider();
      expect(
        await stripe.createCustomer({
          email: 'a@b.c',
          name: 'A B',
          idempotencyKey: 'customer_d1_stripe',
        }),
      ).toEqual({ customerId: 'cus_1' });
      expect(client.customers.create).toHaveBeenCalledWith(
        { email: 'a@b.c', name: 'A B' },
        { idempotencyKey: 'customer_d1_stripe' },
      );
    });

    it('recognizes a stale customer error', () => {
      const { stripe } = provider();
      expect(stripe.isUnknownCustomerError(new Error("No such customer: 'cus_x'"))).toBe(true);
      expect(stripe.isUnknownCustomerError('resource_missing')).toBe(true);
      expect(stripe.isUnknownCustomerError(new Error('card_declined'))).toBe(false);
    });

    it('starts a web setup with a card SetupIntent', async () => {
      const { client, stripe } = provider();
      const session = await stripe.startMethodSetup({
        customerId: 'cus_1',
        channel: 'web',
        currency: 'USD',
        countryCode: 'US',
      });
      expect(client.setupIntents.create).toHaveBeenCalledWith({
        customer: 'cus_1',
        allowed_payment_method_types: ['card'],
      });
      expect(session).toEqual({
        provider: 'stripe',
        clientSecret: 'seti_1_secret',
        customerId: 'cus_1',
        publishableKey: 'pk_test_1',
      });
      expect(client.ephemeralKeys.create).not.toHaveBeenCalled();
    });

    it('adds an ephemeral key for the native sheet with the SDK API version', async () => {
      const { client, stripe } = provider();
      const session = await stripe.startMethodSetup({
        customerId: 'cus_1',
        channel: 'native',
        currency: 'USD',
        countryCode: 'US',
        nativeSdkVersion: '2024-06-20',
      });
      expect(client.ephemeralKeys.create).toHaveBeenCalledWith(
        { customer: 'cus_1' },
        { apiVersion: '2024-06-20' },
      );
      expect(session).toMatchObject({ ephemeralKey: 'ek_secret' });
      await expect(
        stripe.startMethodSetup({
          customerId: 'cus_1',
          channel: 'native',
          currency: 'USD',
          countryCode: 'US',
        }),
      ).rejects.toBeInstanceOf(PaymentValidationError);
    });

    it('fails when Stripe returns a SetupIntent without a client secret', async () => {
      const { client, stripe } = provider();
      client.setupIntents.create.mockResolvedValueOnce({ id: 'seti_2', client_secret: null });
      await expect(
        stripe.startMethodSetup({
          customerId: 'cus_1',
          channel: 'web',
          currency: 'USD',
          countryCode: 'US',
        }),
      ).rejects.toBeInstanceOf(PaymentProviderUnavailableError);
    });

    it('verifies a method server-side and refuses another customer’s method', async () => {
      const { client, stripe } = provider();
      expect(await stripe.verifyMethod({ methodId: 'pm_1', customerId: 'cus_1' })).toEqual({
        methodId: 'pm_1',
        customerId: 'cus_1',
        brand: 'visa',
        last4: '4242',
      });
      client.paymentMethods.retrieve.mockResolvedValueOnce({
        id: 'pm_1',
        customer: { id: 'cus_2' },
      });
      await expect(
        stripe.verifyMethod({ methodId: 'pm_1', customerId: 'cus_1' }),
      ).rejects.toBeInstanceOf(PaymentMethodOwnershipError);
    });

    it('saves a confirmed SetupIntent method through submitMethodSetup', async () => {
      const { stripe } = provider();
      expect(
        await stripe.submitMethodSetup({
          customerId: 'cus_1',
          payload: { paymentMethodId: 'pm_1' },
          idempotencyKey: 'k',
        }),
      ).toMatchObject({ status: 'saved', method: { methodId: 'pm_1', last4: '4242' } });
      await expect(
        stripe.submitMethodSetup({ customerId: 'cus_1', payload: {}, idempotencyKey: 'k' }),
      ).rejects.toBeInstanceOf(PaymentValidationError);
      await expect(stripe.continueMethodSetup()).rejects.toBeInstanceOf(
        PaymentOperationNotSupportedError,
      );
    });

    it('detaches a method', async () => {
      const { client, stripe } = provider();
      await stripe.detachMethod({ customerId: 'cus_1', methodId: 'pm_1' });
      expect(client.paymentMethods.detach).toHaveBeenCalledWith('pm_1');
    });
  });

  it('maps the intent status for reconciliation', async () => {
    const { client, stripe } = provider();
    client.paymentIntents.retrieve.mockResolvedValueOnce({
      status: 'succeeded',
      amount_received: 4200,
    });
    const state = await stripe.getPaymentState('pi_1');
    expect(state.providerStatus).toBe('succeeded');
    expect([...(state.acceptableLocalStatuses ?? [])]).toEqual([
      'captured',
      'partially_refunded',
      'refunded',
    ]);
    expect(state.capturedCents).toBe(4200);
    client.paymentIntents.retrieve.mockResolvedValueOnce({
      status: 'unknown_new',
      amount_received: 0,
    });
    expect((await stripe.getPaymentState('pi_1')).acceptableLocalStatuses).toBeNull();
  });

  describe('verifyWebhook', () => {
    function signed(event: Record<string, unknown>, secret = 'whsec_test') {
      const payload = JSON.stringify(event);
      const header = realStripe.webhooks.generateTestHeaderString({ payload, secret });
      return { payload, headers: { 'stripe-signature': header } };
    }

    it('normalizes a failed intent, a refund, a dispute and ignores the rest', () => {
      const { stripe } = provider();
      const failed = signed({
        id: 'evt_1',
        created: 1_700_000_000,
        type: 'payment_intent.payment_failed',
        data: { object: { id: 'pi_1', last_payment_error: { message: 'Declined' } } },
      });
      expect(stripe.verifyWebhook(failed.payload, failed.headers)).toEqual([
        {
          eventId: 'evt_1',
          type: 'payment.failed',
          paymentId: 'pi_1',
          reason: 'Declined',
          occurredAt: new Date(1_700_000_000_000),
          providerType: 'payment_intent.payment_failed',
        },
      ]);

      const refunded = signed({
        id: 'evt_2',
        created: 1_700_000_000,
        type: 'charge.refunded',
        data: {
          object: { payment_intent: { id: 'pi_1' }, amount_refunded: 300, amount_captured: 900 },
        },
      });
      expect(stripe.verifyWebhook(refunded.payload, refunded.headers)[0]).toMatchObject({
        type: 'payment.refunded',
        paymentId: 'pi_1',
        refundId: null,
        amountCents: null,
        cumulativeRefundedCents: 300,
        capturedCents: 900,
        providerType: 'charge.refunded',
      });

      const disputed = signed({
        id: 'evt_3',
        created: 1_700_000_000,
        type: 'charge.dispute.created',
        data: { object: { id: 'dp_1', payment_intent: 'pi_1', reason: 'fraudulent' } },
      });
      expect(stripe.verifyWebhook(disputed.payload, disputed.headers)[0]).toMatchObject({
        type: 'payment.disputed',
        disputeId: 'dp_1',
        reason: 'fraudulent',
        providerType: 'charge.dispute.created',
      });

      const noIntent = signed({
        id: 'evt_4',
        created: 1_700_000_000,
        type: 'charge.refunded',
        data: { object: { payment_intent: null } },
      });
      expect(stripe.verifyWebhook(noIntent.payload, noIntent.headers)[0]).toMatchObject({
        type: 'ignored',
        providerType: 'charge.refunded',
      });

      const other = signed({
        id: 'evt_5',
        created: 1_700_000_000,
        type: 'customer.created',
        data: { object: {} },
      });
      expect(stripe.verifyWebhook(other.payload, other.headers)[0]?.type).toBe('ignored');
    });

    it('refuses a missing or wrong signature and an unconfigured secret', () => {
      const { stripe } = provider();
      const event = signed(
        { id: 'evt_1', created: 1, type: 'x', data: { object: {} } },
        'whsec_other',
      );
      expect(() => stripe.verifyWebhook(event.payload, {})).toThrow(WebhookSignatureError);
      const err = (() => {
        try {
          stripe.verifyWebhook(event.payload, event.headers);
        } catch (e) {
          return e as WebhookSignatureError;
        }
        return null;
      })();
      expect(err?.reason).toBe('invalid');
      expect(() => provider(fakeClient(), null).stripe.verifyWebhook('{}', {})).toThrow(
        WebhookNotConfiguredError,
      );
    });

    it('acknowledges like the current route', () => {
      expect(provider().stripe.webhookAck()).toEqual({
        status: 200,
        contentType: 'application/json',
        body: '{"received":true}',
      });
    });
  });
});

describe('stripeProviderFactory', () => {
  const base = { provider: 'stripe', preAuthAmountCents: 5000, adyen: emptyAdyenSettings() };

  it('is not configured without a secret or publishable key', async () => {
    expect(
      await stripeProviderFactory.create({
        ...base,
        stripe: { secretKey: null, publishableKey: 'pk', webhookSecret: null },
      }),
    ).toBeNull();
    expect(
      await stripeProviderFactory.create({
        ...base,
        stripe: { secretKey: 'sk_test_1', publishableKey: null, webhookSecret: null },
      }),
    ).toBeNull();
  });

  it('builds a provider from the decrypted keys', async () => {
    const built = await stripeProviderFactory.create({
      ...base,
      stripe: { secretKey: 'sk_test_1', publishableKey: 'pk_test_1', webhookSecret: 'whsec_1' },
    });
    expect(built?.id).toBe('stripe');
    expect(built?.clientConfig()).toEqual({ provider: 'stripe', publishableKey: 'pk_test_1' });
  });
});
