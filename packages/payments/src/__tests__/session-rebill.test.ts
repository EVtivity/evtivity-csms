// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type Stripe from 'stripe';

const m = vi.hoisted(() => {
  const methodRows: { value: unknown[] } = { value: [] };
  const chain: Record<string, unknown> = {};
  for (const method of ['from', 'where']) chain[method] = () => chain;
  chain['limit'] = () => Promise.resolve(methodRows.value);
  return {
    methodRows,
    db: { select: vi.fn(() => chain) },
    getPlatformFeePercent: vi.fn(),
    holdTerms: vi.fn(),
    claimRebillRecord: vi.fn(),
    findSessionRecord: vi.fn(),
    markChargeCaptured: vi.fn(),
    markChargeFailed: vi.fn(),
  };
});

vi.mock('@evtivity/database', () => ({
  db: m.db,
  driverPaymentMethods: { __table: 'driver_payment_methods' },
  getPlatformFeePercent: m.getPlatformFeePercent,
}));

vi.mock('drizzle-orm', () => ({
  and: (...args: unknown[]) => ({ and: args }),
  eq: (a: unknown, b: unknown) => ({ eq: [a, b] }),
}));

vi.mock('../session-payments.js', () => ({ holdTerms: m.holdTerms }));
vi.mock('../payout-accounts.js', () => ({ PAYOUT_NOT_READY_FAILURE: 'Payout account not ready' }));
vi.mock('../payment-records.js', () => ({
  claimRebillRecord: m.claimRebillRecord,
  findSessionRecord: m.findSessionRecord,
  markChargeCaptured: m.markChargeCaptured,
  markChargeFailed: m.markChargeFailed,
  rebillChargeRequest: (record: { metadata: { rebill?: { request?: unknown } } | null }) =>
    record.metadata?.rebill?.request ?? null,
}));

import { chargeSessionRebill } from '../session-rebill.js';
import type { SessionRebillChargeInput } from '../session-rebill.js';
import {
  PaymentDeclinedError,
  PaymentProviderNotConfiguredError,
  PaymentProviderUnavailableError,
} from '../errors.js';
import { StripePaymentProvider } from '../providers/stripe/index.js';
import { SimulatedPaymentProvider } from '../providers/simulated/index.js';
import { fakeAdyenProvider } from '../testing/fake-adyen.js';
import type { PaymentContext } from '../context.js';
import type { PaymentProviderRegistry } from '../registry.js';
import type { PaymentProvider } from '../types.js';
import { fakeClient } from './helpers/fake-stripe.js';

const KEY = 'test-encryption-key-32chars-long!';
const provider = { id: 'stripe', chargeSavedMethod: vi.fn() };
const registry = { getPaymentProvider: vi.fn() };
const logger = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() };
const ctx: PaymentContext = {
  registry: registry as unknown as PaymentProviderRegistry,
  logger,
};

const input: SessionRebillChargeInput = {
  sessionId: 'ses_abc123def456',
  driverId: 'drv_1',
  siteId: 'sit_1',
  grossCents: 1190,
  currency: 'EUR',
  taxRate: 0.19,
};

beforeEach(() => {
  vi.clearAllMocks();
  m.methodRows.value = [{ provider: 'stripe', customerId: 'cus_1', methodId: 'pm_1' }];
  m.getPlatformFeePercent.mockResolvedValue(10);
  m.holdTerms.mockResolvedValue({
    preAuthAmountCents: 5000,
    sitePaymentConfigId: 3,
    payoutAccountId: 'acct_site',
    payoutBlocked: false,
  });
  m.findSessionRecord.mockResolvedValue(null);
  m.claimRebillRecord.mockImplementation((claim: { request: unknown }) =>
    Promise.resolve({ state: 'claimed', id: 9, request: claim.request, resumed: false }),
  );
  m.markChargeCaptured.mockResolvedValue(true);
  m.markChargeFailed.mockResolvedValue(true);
  provider.chargeSavedMethod.mockResolvedValue({
    paymentId: 'pi_rebill',
    amountCents: 1190,
    applicationFeeCents: 100,
  });
  registry.getPaymentProvider.mockResolvedValue(provider);
});

describe('chargeSessionRebill', () => {
  it('charges the default method off session with the rebill key and the session currency', async () => {
    await expect(chargeSessionRebill(input, ctx)).resolves.toEqual({
      status: 'charged',
      paymentRecordId: 9,
      provider: 'stripe',
      amountCents: 1190,
      recorded: true,
    });
    expect(m.claimRebillRecord).toHaveBeenCalledWith({
      sessionId: input.sessionId,
      driverId: 'drv_1',
      sitePaymentConfigId: 3,
      request: {
        provider: 'stripe',
        customerId: 'cus_1',
        methodId: 'pm_1',
        grossCents: 1190,
        currency: 'EUR',
        feeTaxRate: 0.19,
        platformFeePercent: 10,
        payoutAccountId: 'acct_site',
      },
    });
    expect(provider.chargeSavedMethod).toHaveBeenCalledWith({
      customerId: 'cus_1',
      methodId: 'pm_1',
      grossCents: 1190,
      currency: 'EUR',
      feeTaxRate: 0.19,
      platformFeePercent: 10,
      payoutAccountId: 'acct_site',
      description: 'Charging session',
      metadata: { sessionId: input.sessionId, type: 'session_rebill' },
      idempotencyKey: `rebill_${input.sessionId}`,
    });
    expect(m.markChargeCaptured).toHaveBeenCalledWith(9, {
      provider: 'stripe',
      paymentId: 'pi_rebill',
      amountCents: 1190,
    });
  });

  it('reports no payment method without writing anything', async () => {
    m.methodRows.value = [];
    await expect(chargeSessionRebill(input, ctx)).resolves.toEqual({
      status: 'no_payment_method',
    });
    expect(m.claimRebillRecord).not.toHaveBeenCalled();
  });

  it('reports a provider this process cannot use without writing anything', async () => {
    registry.getPaymentProvider.mockRejectedValue(new PaymentProviderNotConfiguredError('stripe'));
    await expect(chargeSessionRebill(input, ctx)).resolves.toEqual({ status: 'not_configured' });
    expect(m.claimRebillRecord).not.toHaveBeenCalled();
  });

  it('charges nothing when the record holds another payment', async () => {
    m.claimRebillRecord.mockResolvedValue({ state: 'refused', status: 'pre_authorized' });
    await expect(chargeSessionRebill(input, ctx)).resolves.toEqual({
      status: 'record_refused',
      recordStatus: 'pre_authorized',
    });
    expect(provider.chargeSavedMethod).not.toHaveBeenCalled();
  });

  it('reports an earlier charge or decline of the same re-bill without a second call', async () => {
    m.claimRebillRecord.mockResolvedValueOnce({ state: 'charged', id: 9, amountCents: 1190 });
    await expect(chargeSessionRebill(input, ctx)).resolves.toMatchObject({
      status: 'charged',
      paymentRecordId: 9,
      amountCents: 1190,
    });
    m.claimRebillRecord.mockResolvedValueOnce({
      state: 'failed',
      id: 9,
      reason: 'declined',
      amountCents: 1000,
    });
    await expect(chargeSessionRebill(input, ctx)).resolves.toEqual({
      status: 'failed',
      paymentRecordId: 9,
      reason: 'declined',
      code: null,
      amountCents: 1000,
    });
    expect(provider.chargeSavedMethod).not.toHaveBeenCalled();
  });

  it('refuses the charge when the payout account of the site is not ready (O5)', async () => {
    m.holdTerms.mockResolvedValue({
      preAuthAmountCents: 5000,
      sitePaymentConfigId: 3,
      payoutAccountId: null,
      payoutBlocked: true,
    });
    await expect(chargeSessionRebill(input, ctx)).resolves.toEqual({
      status: 'failed',
      paymentRecordId: 9,
      reason: 'Payout account not ready',
      code: 'payout_not_ready',
      amountCents: 1190,
    });
    expect(m.markChargeFailed).toHaveBeenCalledWith(9, 'Payout account not ready');
    expect(provider.chargeSavedMethod).not.toHaveBeenCalled();
  });

  it('records a decline, including an authentication the off-session charge cannot do', async () => {
    provider.chargeSavedMethod.mockRejectedValue(
      new PaymentDeclinedError('Your card requires authentication.', {
        code: 'authentication_required',
      }),
    );
    await expect(chargeSessionRebill(input, ctx)).resolves.toEqual({
      status: 'failed',
      paymentRecordId: 9,
      reason: 'Your card requires authentication.',
      code: 'authentication_required',
      amountCents: 1190,
    });
    expect(m.markChargeFailed).toHaveBeenCalledWith(9, 'Your card requires authentication.');
  });

  it('leaves the record pending and throws when the outcome is unknown', async () => {
    provider.chargeSavedMethod.mockRejectedValue(new PaymentProviderUnavailableError('timeout'));
    await expect(chargeSessionRebill(input, ctx)).rejects.toThrow('timeout');
    expect(m.markChargeFailed).not.toHaveBeenCalled();
    expect(m.markChargeCaptured).not.toHaveBeenCalled();
  });

  it('resumes a charge with an unknown outcome with its stored request, not the new amount', async () => {
    const stored = {
      provider: 'stripe',
      customerId: 'cus_old',
      methodId: 'pm_old',
      grossCents: 1000,
      currency: 'EUR',
      feeTaxRate: 0.19,
      platformFeePercent: 5,
      payoutAccountId: 'acct_old',
    };
    m.findSessionRecord.mockResolvedValue({
      status: 'pending',
      metadata: { rebill: { request: stored } },
    });
    m.claimRebillRecord.mockResolvedValue({
      state: 'claimed',
      id: 9,
      request: stored,
      resumed: true,
    });
    // The payout account is not ready now, but the charge was sent before.
    m.holdTerms.mockResolvedValue({
      preAuthAmountCents: 5000,
      sitePaymentConfigId: 3,
      payoutAccountId: null,
      payoutBlocked: true,
    });
    m.methodRows.value = [];
    await expect(chargeSessionRebill(input, ctx)).resolves.toMatchObject({
      status: 'charged',
      amountCents: 1000,
    });
    expect(m.markChargeFailed).not.toHaveBeenCalled();
    expect(provider.chargeSavedMethod).toHaveBeenCalledWith(
      expect.objectContaining({
        customerId: 'cus_old',
        methodId: 'pm_old',
        grossCents: 1000,
        platformFeePercent: 5,
        payoutAccountId: 'acct_old',
        idempotencyKey: `rebill_${input.sessionId}`,
      }),
    );
    expect(m.markChargeCaptured).toHaveBeenCalledWith(9, {
      provider: 'stripe',
      paymentId: 'pi_rebill',
      amountCents: 1000,
    });
  });

  it('charges nothing for a charge older than the key retention or a lost session claim', async () => {
    m.claimRebillRecord.mockResolvedValueOnce({ state: 'refused', status: 'pending' });
    await expect(chargeSessionRebill(input, ctx)).resolves.toEqual({
      status: 'record_refused',
      recordStatus: 'pending',
    });
    m.claimRebillRecord.mockResolvedValueOnce({ state: 'session_not_claimed' });
    await expect(chargeSessionRebill(input, ctx)).resolves.toEqual({
      status: 'session_not_claimed',
    });
    expect(provider.chargeSavedMethod).not.toHaveBeenCalled();
  });

  it('logs a charge whose record moved on', async () => {
    m.markChargeCaptured.mockResolvedValue(false);
    await expect(chargeSessionRebill(input, ctx)).resolves.toMatchObject({
      status: 'charged',
      recorded: false,
    });
    expect(logger.error).toHaveBeenCalled();
  });
});

describe('chargeSessionRebill per provider', () => {
  function useProvider(real: PaymentProvider, methodId: string, customerId = 'cus_1'): void {
    m.methodRows.value = [{ provider: real.id, customerId, methodId }];
    registry.getPaymentProvider.mockResolvedValue(real);
    m.holdTerms.mockResolvedValue({
      preAuthAmountCents: 5000,
      sitePaymentConfigId: null,
      payoutAccountId: null,
      payoutBlocked: false,
    });
  }

  it('stripe: an immediate off-session PaymentIntent, a 3DS answer declines', async () => {
    const client = fakeClient();
    client.paymentIntents.create.mockResolvedValueOnce({ id: 'pi_rebill', status: 'succeeded' });
    useProvider(
      new StripePaymentProvider({
        client: client as unknown as Stripe,
        publishableKey: 'pk_test_1',
        webhookSecret: 'whsec_test',
        connectWebhookSecret: null,
      }),
      'pm_1',
    );
    await expect(chargeSessionRebill(input, ctx)).resolves.toMatchObject({
      status: 'charged',
      provider: 'stripe',
    });
    expect(client.paymentIntents.create).toHaveBeenCalledWith(
      expect.objectContaining({
        amount: 1190,
        currency: 'eur',
        customer: 'cus_1',
        payment_method: 'pm_1',
        confirm: true,
        off_session: true,
      }),
      { idempotencyKey: `rebill_${input.sessionId}` },
    );

    client.paymentIntents.create.mockResolvedValueOnce({
      id: 'pi_3ds',
      status: 'requires_action',
      last_payment_error: { message: 'Authentication required', code: 'authentication_required' },
    });
    await expect(chargeSessionRebill(input, ctx)).resolves.toMatchObject({
      status: 'failed',
      code: 'authentication_required',
    });
  });

  it('adyen: a merchant-initiated stored-card payment, an action declines', async () => {
    const { provider: adyen, adyen: server } = fakeAdyenProvider();
    useProvider(adyen, 'STORED_1', 'evt_shopper');
    server.next({ body: { resultCode: 'Authorised', pspReference: 'PSP_REBILL' } });
    await expect(chargeSessionRebill(input, ctx)).resolves.toMatchObject({
      status: 'charged',
      provider: 'adyen',
    });
    const call = server.last();
    expect(call.path).toMatch(/\/payments$/);
    expect(call.headers['idempotency-key']).toBe(`rebill_${input.sessionId}`);
    expect(call.body).toMatchObject({
      amount: { value: 1190, currency: 'EUR' },
      shopperInteraction: 'ContAuth',
      recurringProcessingModel: 'UnscheduledCardOnFile',
      paymentMethod: { storedPaymentMethodId: 'STORED_1' },
    });
    expect(m.markChargeCaptured).toHaveBeenCalledWith(9, {
      provider: 'adyen',
      paymentId: 'PSP_REBILL',
      amountCents: 1190,
    });

    server.next({
      body: { resultCode: 'IdentifyShopper', action: { type: 'threeDS2' } },
    });
    await expect(chargeSessionRebill(input, ctx)).resolves.toMatchObject({
      status: 'failed',
      code: 'authentication_required',
    });
  });

  it('simulated: approves a saved test card, declines a 3DS card off session', async () => {
    const simulated = new SimulatedPaymentProvider({ encryptionKey: KEY });
    const { customerId } = await simulated.createCustomer({
      email: 'driver@example.com',
      name: 'Driver One',
      idempotencyKey: 'customer_d1',
    });
    const approved = await simulated.submitMethodSetup({
      customerId,
      payload: { testCard: '4242424242424242' },
      idempotencyKey: 'method_d1',
    });
    if (approved.status !== 'saved') throw new Error('test card not saved');
    useProvider(simulated, approved.method.methodId, customerId);
    await expect(chargeSessionRebill(input, ctx)).resolves.toMatchObject({
      status: 'charged',
      provider: 'simulated',
    });

    // A 3DS card saves after its challenge, then needs authentication on every charge.
    const challenge = await simulated.submitMethodSetup({
      customerId,
      payload: { testCard: '4000002500003155' },
      idempotencyKey: 'method_d2',
    });
    if (challenge.status !== 'action_required') throw new Error('3DS test card not challenged');
    const { methodId } = challenge.action.data as { methodId: string };
    const threeDs = await simulated.continueMethodSetup({
      customerId,
      details: { methodId, outcome: 'approve' },
      idempotencyKey: 'method_d2_details',
    });
    if (threeDs.status !== 'saved') throw new Error('3DS test card not saved');
    useProvider(simulated, threeDs.method.methodId, customerId);
    await expect(chargeSessionRebill(input, ctx)).resolves.toMatchObject({
      status: 'failed',
      code: 'authentication_required',
    });
  });
});
