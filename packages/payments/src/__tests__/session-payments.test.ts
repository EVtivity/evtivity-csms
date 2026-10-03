// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { Mock } from 'vitest';

interface SelectCall {
  fields?: unknown;
  table?: unknown;
  join?: unknown[];
  leftJoin?: unknown[];
  where?: unknown;
  limit?: number;
}

const h = vi.hoisted(() => {
  const selects: SelectCall[] = [];
  const results: unknown[][] = [];
  function select(fields?: unknown): Record<string, unknown> {
    const call: SelectCall = { fields };
    selects.push(call);
    const b: Record<string, unknown> = {
      from: (t: unknown) => {
        call.table = t;
        return b;
      },
      innerJoin: (...j: unknown[]) => {
        call.join = j;
        return b;
      },
      leftJoin: (...j: unknown[]) => {
        call.leftJoin = j;
        return b;
      },
      where: (w: unknown) => {
        call.where = w;
        return b;
      },
      limit: (n: number) => {
        call.limit = n;
        return b;
      },
      then: (resolve: (v: unknown) => unknown, reject: (e: unknown) => unknown) => {
        const next = results.shift() ?? [];
        return (next instanceof Error ? Promise.reject(next) : Promise.resolve(next)).then(
          resolve,
          reject,
        );
      },
    };
    return b;
  }
  return {
    selects,
    results,
    select,
    execute: vi.fn(),
    getPlatformFeePercent: vi.fn(),
    sessionChargeTax: vi.fn(),
    getSitePaymentConfig: vi.fn(),
    findRecord: vi.fn(),
    findSessionHold: vi.fn(),
    findSessionRecord: vi.fn(),
    markCancelled: vi.fn(),
    markCaptured: vi.fn(),
    markHoldFailed: vi.fn(),
    settlePrepaidSession: vi.fn(),
    markShortfallRecovered: vi.fn(),
    markShortfallRetryFailed: vi.fn(),
    recordFailedHold: vi.fn(),
    recordHold: vi.fn(),
  };
});

vi.mock('@evtivity/database', () => ({
  db: { select: h.select, execute: h.execute },
  chargingSessions: {
    id: 'cs.id',
    currency: 'cs.currency',
    stationId: 'cs.station_id',
    finalCostCents: 'cs.final_cost_cents',
    tariffTaxRate: 'cs.tariff_tax_rate',
    costBreakdown: 'cs.cost_breakdown',
    tokenId: 'cs.token_id',
  },
  chargingStations: { id: 'st.id', siteId: 'st.site_id' },
  driverTokens: { id: 't.id', prepaidBalanceCents: 't.prepaid_balance_cents' },
  driverPaymentMethods: {
    id: 'm.id',
    driverId: 'm.driver_id',
    isDefault: 'm.is_default',
    stripeCustomerId: 'm.stripe_customer_id',
    stripePaymentMethodId: 'm.stripe_payment_method_id',
  },
  getPlatformFeePercent: h.getPlatformFeePercent,
}));
vi.mock('@evtivity/lib', () => ({ sessionChargeTax: h.sessionChargeTax }));
vi.mock('drizzle-orm', () => ({
  and: (...args: unknown[]) => ({ op: 'and', args }),
  eq: (col: unknown, value: unknown) => ({ op: 'eq', col, value }),
  sql: (strings: TemplateStringsArray, ...values: unknown[]) => ({
    op: 'sql',
    text: strings.join('?'),
    values,
  }),
}));
vi.mock('../settings.js', () => ({ getSitePaymentConfig: h.getSitePaymentConfig }));
vi.mock('../payment-records.js', () => ({
  findRecord: h.findRecord,
  findSessionHold: h.findSessionHold,
  findSessionRecord: h.findSessionRecord,
  markCancelled: h.markCancelled,
  markCaptured: h.markCaptured,
  markHoldFailed: h.markHoldFailed,
  settlePrepaidSession: h.settlePrepaidSession,
  markShortfallRecovered: h.markShortfallRecovered,
  markShortfallRetryFailed: h.markShortfallRetryFailed,
  recordFailedHold: h.recordFailedHold,
  recordHold: h.recordHold,
}));

import {
  authorizeSessionHold,
  cancelSessionHold,
  captureSessionHold,
  holdTerms,
  retryShortfallForRecord,
  retryShortfalls,
  settleSessionPayment,
} from '../session-payments.js';
import type { SessionHoldInput } from '../session-payments.js';
import { PaymentDeclinedError, PaymentProviderNotConfiguredError } from '../errors.js';
import type { PaymentContext } from '../context.js';
import type { PaymentRecord } from '../payment-records.js';
import type { PaymentProviderRegistry } from '../registry.js';

interface FakeProvider {
  id: string;
  authorizeHold: Mock<(input: unknown) => Promise<unknown>>;
  cancelHold: Mock<(input: unknown) => Promise<unknown>>;
  capture: Mock<(input: unknown) => Promise<unknown>>;
  chargeShortfall: Mock<(input: unknown) => Promise<unknown>>;
}

function fakeProvider(id: string): FakeProvider {
  return {
    id,
    authorizeHold: vi.fn(() =>
      Promise.resolve({ status: 'authorized', paymentId: 'pi_new', authorizedCents: 5000 }),
    ),
    cancelHold: vi.fn(() => Promise.resolve({ state: 'succeeded' })),
    capture: vi.fn(() =>
      Promise.resolve({ state: 'succeeded', capturedCents: 0, applicationFeeCents: 0 }),
    ),
    chargeShortfall: vi.fn(() =>
      Promise.resolve({ paymentId: 'pi_top', amountCents: 2000, applicationFeeCents: 0 }),
    ),
  };
}

let stripe: FakeProvider;
let simulated: FakeProvider;
const getPaymentProvider = vi.fn();
const settings = vi.fn();
const logger = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() };
const ctx: PaymentContext = {
  registry: { getPaymentProvider, settings } as unknown as PaymentProviderRegistry,
  logger,
};

const FEE_TAX = { taxRate: 0.19, tag: 'fee-tax' };

function record(overrides: Partial<PaymentRecord> = {}): PaymentRecord {
  return {
    id: 42,
    sessionId: 's1',
    driverId: 'd1',
    sitePaymentConfigId: null,
    stripePaymentIntentId: 'pi_1',
    stripeCustomerId: 'cus_1',
    stripePaymentMethodId: 'pm_1',
    paymentSource: 'web_portal',
    currency: 'EUR',
    preAuthAmountCents: 5000,
    capturedAmountCents: 5000,
    refundedAmountCents: 0,
    status: 'pre_authorized',
    failureReason: null,
    lastActorUserId: null,
    lastActionReason: null,
    metadata: null,
    chargeType: 'session',
    reservationId: null,
    taxRate: null,
    createdAt: new Date(),
    updatedAt: new Date(),
    ...overrides,
  };
}

const CHARGE = {
  finalCostCents: 7000,
  tariffTaxRate: '0.19',
  costBreakdown: { energy: 7000 },
  siteId: 'site1',
};

beforeEach(() => {
  h.selects.length = 0;
  h.results.length = 0;
  stripe = fakeProvider('stripe');
  simulated = fakeProvider('simulated');
  getPaymentProvider.mockImplementation((id: string) =>
    Promise.resolve(id === 'simulated' ? simulated : stripe),
  );
  settings.mockResolvedValue({ preAuthAmountCents: 2500 });
  h.getSitePaymentConfig.mockResolvedValue(null);
  h.getPlatformFeePercent.mockResolvedValue(5);
  h.sessionChargeTax.mockReturnValue(FEE_TAX);
  h.findSessionRecord.mockResolvedValue(null);
  h.recordHold.mockResolvedValue(77);
  h.recordFailedHold.mockResolvedValue(78);
  h.markCancelled.mockResolvedValue(true);
  h.markCaptured.mockResolvedValue(true);
  h.markShortfallRecovered.mockResolvedValue(null);
  h.markShortfallRetryFailed.mockResolvedValue(true);
  h.findRecord.mockResolvedValue(null);
});

describe('holdTerms', () => {
  it('uses the site config when the site has one', async () => {
    h.getSitePaymentConfig.mockResolvedValue({
      configId: 3,
      payoutAccountId: 'acct_1',
      preAuthAmountCents: 9000,
    });
    expect(await holdTerms(ctx, 'site1')).toEqual({
      preAuthAmountCents: 9000,
      sitePaymentConfigId: 3,
      payoutAccountId: 'acct_1',
    });
    expect(h.getSitePaymentConfig).toHaveBeenCalledWith('site1');
    expect(settings).not.toHaveBeenCalled();
  });

  it('falls back to the global settings', async () => {
    expect(await holdTerms(ctx, 'site1')).toEqual({
      preAuthAmountCents: 2500,
      sitePaymentConfigId: null,
      payoutAccountId: null,
    });
  });

  it('reads no site config without a site', async () => {
    expect(await holdTerms(ctx, null)).toMatchObject({ preAuthAmountCents: 2500 });
    expect(h.getSitePaymentConfig).not.toHaveBeenCalled();
  });
});

describe('authorizeSessionHold', () => {
  const input: SessionHoldInput = {
    sessionId: 's1',
    driverId: 'd1',
    methodRowId: null,
    siteId: null,
    trigger: 'projection_gate',
  };
  const METHOD = { id: 5, customerId: 'cus_1', methodId: 'pm_1' };

  it('returns exists without calling the provider when a record exists', async () => {
    h.findSessionRecord.mockResolvedValue(record({ id: 9, status: 'failed' }));
    expect(await authorizeSessionHold(input, ctx)).toEqual({
      outcome: 'exists',
      paymentRecordId: 9,
      status: 'failed',
    });
    expect(getPaymentProvider).not.toHaveBeenCalled();
    expect(h.selects).toHaveLength(0);
  });

  it('returns no_method when the driver has no default method', async () => {
    h.results.push([]);
    expect(await authorizeSessionHold(input, ctx)).toEqual({ outcome: 'no_method' });
    expect(h.selects[0]?.where).toEqual({
      op: 'and',
      args: [
        { op: 'eq', col: 'm.driver_id', value: 'd1' },
        { op: 'eq', col: 'm.is_default', value: true },
      ],
    });
  });

  it('returns no_method without a driver or method row and reads nothing', async () => {
    expect(await authorizeSessionHold({ ...input, driverId: null }, ctx)).toEqual({
      outcome: 'no_method',
    });
    expect(h.selects).toHaveLength(0);
  });

  it('returns not_configured when the pinned provider is not configured', async () => {
    h.results.push([METHOD]);
    getPaymentProvider.mockRejectedValue(new PaymentProviderNotConfiguredError('stripe'));
    expect(await authorizeSessionHold(input, ctx)).toEqual({
      outcome: 'not_configured',
      providerId: 'stripe',
    });
  });

  it('rethrows other pinning errors', async () => {
    h.results.push([METHOD]);
    getPaymentProvider.mockRejectedValue(new Error('settings down'));
    await expect(authorizeSessionHold(input, ctx)).rejects.toThrow('settings down');
  });

  it('throws when the session is not found', async () => {
    h.results.push([METHOD], []);
    await expect(authorizeSessionHold(input, ctx)).rejects.toThrow('Session s1 not found');
    expect(stripe.authorizeHold).not.toHaveBeenCalled();
  });

  it('places the hold with the site terms and records it', async () => {
    h.results.push(
      [{ id: 5, customerId: 'cus_sim_1', methodId: 'pm_sim_1' }],
      [{ currency: 'EUR' }],
    );
    h.getSitePaymentConfig.mockResolvedValue({
      configId: 3,
      payoutAccountId: 'acct_1',
      preAuthAmountCents: 9000,
    });
    const outcome = await authorizeSessionHold(
      { ...input, methodRowId: 5, siteId: 'site1', trigger: 'portal_start' },
      ctx,
    );
    expect(outcome).toEqual({ outcome: 'authorized', paymentRecordId: 77, paymentId: 'pi_new' });
    expect(h.selects[0]?.where).toEqual({ op: 'eq', col: 'm.id', value: 5 });
    expect(getPaymentProvider).toHaveBeenCalledWith('simulated');
    expect(simulated.authorizeHold).toHaveBeenCalledWith({
      method: { kind: 'saved', customerId: 'cus_sim_1', methodId: 'pm_sim_1' },
      initiator: 'merchant',
      merchantReference: 'sess_s1',
      amountCents: 9000,
      currency: 'EUR',
      payoutAccountId: 'acct_1',
      idempotencyKey: 'preauth_s1',
    });
    expect(h.recordHold).toHaveBeenCalledWith({
      sessionId: 's1',
      driverId: 'd1',
      sitePaymentConfigId: 3,
      paymentId: 'pi_new',
      customerId: 'cus_sim_1',
      methodId: 'pm_sim_1',
      source: 'web_portal',
      currency: 'EUR',
      preAuthAmountCents: 9000,
    });
  });

  it('uses the operator amount override', async () => {
    h.results.push([METHOD], [{ currency: 'USD' }]);
    await authorizeSessionHold({ ...input, amountCents: 1234, trigger: 'operator' }, ctx);
    expect(stripe.authorizeHold).toHaveBeenCalledWith(
      expect.objectContaining({ amountCents: 1234, currency: 'USD', payoutAccountId: null }),
    );
  });

  it('treats action_required as a decline', async () => {
    h.results.push([METHOD], [{ currency: 'EUR' }]);
    stripe.authorizeHold.mockResolvedValue({
      status: 'action_required',
      paymentId: 'pi_x',
      action: { provider: 'stripe', data: null },
    });
    expect(await authorizeSessionHold(input, ctx)).toEqual({
      outcome: 'declined',
      reason: 'Payment requires authentication',
      paymentRecordId: 78,
    });
    const err = logger.warn.mock.calls[0]?.[0] as { err: unknown };
    expect(err.err).toBeInstanceOf(PaymentDeclinedError);
    expect(h.recordHold).not.toHaveBeenCalled();
  });

  it('records a decline without the hold amount for non-operator triggers', async () => {
    h.results.push([METHOD], [{ currency: 'EUR' }]);
    stripe.authorizeHold.mockRejectedValue(new PaymentDeclinedError('card_declined'));
    expect(await authorizeSessionHold(input, ctx)).toEqual({
      outcome: 'declined',
      reason: 'card_declined',
      paymentRecordId: 78,
    });
    expect(h.recordFailedHold).toHaveBeenCalledWith({
      sessionId: 's1',
      driverId: 'd1',
      sitePaymentConfigId: null,
      customerId: 'cus_1',
      methodId: 'pm_1',
      source: 'web_portal',
      currency: 'EUR',
      preAuthAmountCents: null,
      reason: 'card_declined',
    });
    expect(logger.warn).toHaveBeenCalledWith(
      expect.objectContaining({ sessionId: 's1', trigger: 'projection_gate' }),
      'Session pre-authorization declined',
    );
  });

  it('records the hold amount of an operator decline, with a fallback reason', async () => {
    h.results.push([METHOD], [{ currency: 'EUR' }]);
    stripe.authorizeHold.mockRejectedValue('weird');
    const outcome = await authorizeSessionHold({ ...input, trigger: 'operator' }, ctx);
    expect(outcome).toMatchObject({ reason: 'Unknown pre-auth error' });
    expect(h.recordFailedHold).toHaveBeenCalledWith(
      expect.objectContaining({ preAuthAmountCents: 2500 }),
    );
  });

  it('logs a failed decline record and returns no record id', async () => {
    h.results.push([METHOD], [{ currency: 'EUR' }]);
    stripe.authorizeHold.mockRejectedValue(new Error('declined'));
    const dbErr = new Error('db down');
    h.recordFailedHold.mockRejectedValue(dbErr);
    expect(await authorizeSessionHold(input, ctx)).toEqual({
      outcome: 'declined',
      reason: 'declined',
      paymentRecordId: null,
    });
    expect(logger.error).toHaveBeenCalledWith(
      { err: dbErr, sessionId: 's1' },
      'Failed to record the declined pre-authorization',
    );
  });

  it('returns the winner when a concurrent trigger recorded first', async () => {
    h.results.push([METHOD], [{ currency: 'EUR' }]);
    h.recordHold.mockResolvedValue(null);
    h.findSessionRecord
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce(record({ id: 90, status: 'pre_authorized' }));
    expect(await authorizeSessionHold(input, ctx)).toEqual({
      outcome: 'exists',
      paymentRecordId: 90,
      status: 'pre_authorized',
    });
    expect(stripe.cancelHold).not.toHaveBeenCalled();
  });

  it('cancels the hold when the conflict has no winner', async () => {
    h.results.push([METHOD], [{ currency: 'EUR' }]);
    h.recordHold.mockResolvedValue(null);
    expect(await authorizeSessionHold(input, ctx)).toEqual({
      outcome: 'record_failed',
      reason: 'Payment record vanished after a conflict',
    });
    expect(stripe.cancelHold).toHaveBeenCalledWith({
      paymentId: 'pi_new',
      merchantReference: 'sess_s1',
      idempotencyKey: 'cancel_pi_new',
    });
    expect(logger.error).toHaveBeenCalledWith(
      expect.objectContaining({ sessionId: 's1', paymentId: 'pi_new' }),
      'Failed to record successful pre-auth; reversing the hold',
    );
  });

  it('cancels the hold when the record write fails, logging a failed cancel', async () => {
    h.results.push([METHOD], [{ currency: 'EUR' }]);
    h.recordHold.mockRejectedValue('boom');
    const cancelErr = new Error('cancel failed');
    stripe.cancelHold.mockRejectedValue(cancelErr);
    expect(await authorizeSessionHold(input, ctx)).toEqual({
      outcome: 'record_failed',
      reason: 'Unknown database error',
    });
    expect(stripe.cancelHold).toHaveBeenCalledOnce();
    expect(logger.error).toHaveBeenCalledWith(
      { err: cancelErr, sessionId: 's1', paymentId: 'pi_new' },
      'Failed to cancel the hold after the record write failed; manual reconciliation required',
    );
  });
});

describe('captureSessionHold', () => {
  it('returns no_hold without an open hold', async () => {
    h.findSessionHold.mockResolvedValue(null);
    expect(await captureSessionHold({ sessionId: 's1' }, ctx)).toEqual({ status: 'no_hold' });
  });

  it('returns missing_payment_id without a provider payment', async () => {
    h.findSessionHold.mockResolvedValue(record({ stripePaymentIntentId: null }));
    expect(await captureSessionHold({ sessionId: 's1' }, ctx)).toEqual({
      status: 'missing_payment_id',
    });
  });

  it('returns not_configured when the pinned provider is not configured', async () => {
    h.findSessionHold.mockResolvedValue(record());
    h.results.push([CHARGE]);
    getPaymentProvider.mockRejectedValue(new PaymentProviderNotConfiguredError('stripe'));
    expect(await captureSessionHold({ sessionId: 's1' }, ctx)).toEqual({
      status: 'not_configured',
      providerId: 'stripe',
    });
  });

  it('rethrows other pinning errors', async () => {
    h.findSessionHold.mockResolvedValue(record());
    h.results.push([CHARGE]);
    getPaymentProvider.mockRejectedValue(new Error('x'));
    await expect(captureSessionHold({ sessionId: 's1' }, ctx)).rejects.toThrow('x');
  });

  it('captures the final cost by default with the fee tax and platform fee', async () => {
    h.findSessionHold.mockResolvedValue(record());
    h.results.push([CHARGE]);
    const fresh = record({ status: 'captured', capturedAmountCents: 7000 });
    h.findRecord.mockResolvedValue(fresh);
    expect(await captureSessionHold({ sessionId: 's1' }, ctx)).toEqual({
      status: 'captured',
      record: fresh,
    });
    expect(h.selects[0]?.join).toEqual([
      { id: 'st.id', siteId: 'st.site_id' },
      { op: 'eq', col: 'st.id', value: 'cs.station_id' },
    ]);
    expect(h.sessionChargeTax).toHaveBeenCalledWith({
      finalCostCents: 7000,
      tariffTaxRate: '0.19',
      costBreakdown: { energy: 7000 },
    });
    expect(h.getPlatformFeePercent).toHaveBeenCalledWith('site1');
    expect(stripe.capture).toHaveBeenCalledWith({
      paymentId: 'pi_1',
      amountCents: 7000,
      currency: 'EUR',
      merchantReference: 'sess_s1',
      payoutAccountId: null,
      feeTax: FEE_TAX,
      platformFeePercent: 5,
      idempotencyKey: 'capture_42',
    });
    expect(h.markCaptured).toHaveBeenCalledWith(42, { capturedCents: 7000, failureReason: null });
  });

  it('captures an explicit amount without a session and warns when the record moved on', async () => {
    const hold = record();
    h.findSessionHold.mockResolvedValue(hold);
    h.results.push([]);
    h.markCaptured.mockResolvedValue(false);
    expect(await captureSessionHold({ sessionId: 's1', amountCents: 300 }, ctx)).toEqual({
      status: 'captured',
      record: hold,
    });
    expect(h.sessionChargeTax).toHaveBeenCalledWith({
      finalCostCents: null,
      tariffTaxRate: null,
      costBreakdown: null,
    });
    expect(h.getPlatformFeePercent).toHaveBeenCalledWith(null);
    expect(logger.warn).toHaveBeenCalledWith(
      { paymentRecordId: 42 },
      'Hold captured but the record had moved on',
    );
  });

  it('cancels at 0 when there is no session cost', async () => {
    const hold = record();
    h.findSessionHold.mockResolvedValue(hold);
    h.results.push([{ ...CHARGE, finalCostCents: null }]);
    const fresh = record({ status: 'cancelled' });
    h.findRecord.mockResolvedValue(fresh);
    expect(await captureSessionHold({ sessionId: 's1' }, ctx)).toEqual({
      status: 'cancelled',
      record: fresh,
    });
    expect(stripe.cancelHold).toHaveBeenCalledWith({
      paymentId: 'pi_1',
      merchantReference: 'sess_s1',
      idempotencyKey: 'cancel_42',
    });
    expect(stripe.capture).not.toHaveBeenCalled();
    expect(h.markCancelled).toHaveBeenCalledWith(42);
  });

  it('cancels an explicit 0 and warns when the record moved on', async () => {
    const hold = record();
    h.findSessionHold.mockResolvedValue(hold);
    h.results.push([CHARGE]);
    h.markCancelled.mockResolvedValue(false);
    expect(await captureSessionHold({ sessionId: 's1', amountCents: 0 }, ctx)).toEqual({
      status: 'cancelled',
      record: hold,
    });
    expect(logger.warn).toHaveBeenCalledWith(
      { paymentRecordId: 42 },
      'Hold cancelled but the record had moved on',
    );
  });
});

describe('cancelSessionHold', () => {
  it('does nothing without a provider payment', async () => {
    await cancelSessionHold(record({ stripePaymentIntentId: null }), 'r', ctx);
    expect(getPaymentProvider).not.toHaveBeenCalled();
  });

  it('cancels with the session reference', async () => {
    await cancelSessionHold(record(), 'cost 0', ctx);
    expect(stripe.cancelHold).toHaveBeenCalledWith({
      paymentId: 'pi_1',
      merchantReference: 'sess_s1',
      idempotencyKey: 'cancel_42',
    });
    expect(h.markCancelled).toHaveBeenCalledWith(42);
    expect(logger.warn).not.toHaveBeenCalled();
  });

  it('uses the record reference without a session and warns when the record moved on', async () => {
    h.markCancelled.mockResolvedValue(false);
    await cancelSessionHold(record({ sessionId: null }), 'given up', ctx);
    expect(stripe.cancelHold).toHaveBeenCalledWith(
      expect.objectContaining({ merchantReference: 'rec_42' }),
    );
    expect(logger.warn).toHaveBeenCalledWith(
      { paymentRecordId: 42, reason: 'given up' },
      'Hold cancelled but the record had moved on',
    );
  });
});

describe('retryShortfallForRecord', () => {
  const input = { recordId: 42, actorUserId: 'u1' };
  const shortRecord = (overrides: Partial<PaymentRecord> = {}): PaymentRecord =>
    record({ status: 'captured', capturedAmountCents: 5000, ...overrides });

  it('returns not_found for an unknown record', async () => {
    expect(await retryShortfallForRecord(input, ctx)).toEqual({ status: 'not_found' });
  });

  it('is not recoverable without a provider payment', async () => {
    h.findRecord.mockResolvedValue(shortRecord({ stripePaymentIntentId: null }));
    expect(await retryShortfallForRecord(input, ctx)).toEqual({
      status: 'not_recoverable',
      reason: 'Payment has no provider payment',
    });
  });

  it('is not recoverable without a session', async () => {
    h.findRecord.mockResolvedValue(shortRecord({ sessionId: null }));
    expect(await retryShortfallForRecord(input, ctx)).toEqual({
      status: 'not_recoverable',
      reason: 'Payment is not linked to a session',
    });
  });

  it('is not recoverable without a session charge or a shortfall', async () => {
    h.findRecord.mockResolvedValue(shortRecord());
    h.results.push([]);
    expect(await retryShortfallForRecord(input, ctx)).toEqual({
      status: 'not_recoverable',
      reason: 'No shortfall to recover',
    });
    h.results.push([{ ...CHARGE, finalCostCents: 5000 }]);
    expect(await retryShortfallForRecord(input, ctx)).toMatchObject({
      status: 'not_recoverable',
    });
    h.findRecord.mockResolvedValue(shortRecord({ capturedAmountCents: null }));
    h.results.push([{ ...CHARGE, finalCostCents: null }]);
    expect(await retryShortfallForRecord(input, ctx)).toMatchObject({
      status: 'not_recoverable',
    });
    expect(stripe.chargeShortfall).not.toHaveBeenCalled();
  });

  it('returns not_configured when the pinned provider is not configured', async () => {
    h.findRecord.mockResolvedValue(shortRecord());
    h.results.push([CHARGE]);
    getPaymentProvider.mockRejectedValue(new PaymentProviderNotConfiguredError('stripe'));
    expect(await retryShortfallForRecord(input, ctx)).toEqual({
      status: 'not_configured',
      providerId: 'stripe',
    });
  });

  it('returns failed with the message cut to 400 characters', async () => {
    h.findRecord.mockResolvedValue(shortRecord());
    h.results.push([CHARGE]);
    stripe.chargeShortfall.mockRejectedValue(new Error('d'.repeat(450)));
    expect(await retryShortfallForRecord(input, ctx)).toEqual({
      status: 'failed',
      reason: 'd'.repeat(400),
    });
    h.results.push([CHARGE]);
    stripe.chargeShortfall.mockRejectedValue('nope');
    expect(await retryShortfallForRecord(input, ctx)).toEqual({
      status: 'failed',
      reason: 'Top-up failed',
    });
    expect(h.markShortfallRecovered).not.toHaveBeenCalled();
  });

  it('recovers the shortfall on the same method and records the action', async () => {
    h.findRecord.mockResolvedValue(shortRecord());
    h.results.push([CHARGE]);
    const updated = shortRecord({ capturedAmountCents: 7000 });
    h.markShortfallRecovered.mockResolvedValue(updated);
    expect(await retryShortfallForRecord(input, ctx)).toEqual({
      status: 'recovered',
      record: updated,
      shortfallCents: 2000,
      topUpId: 'pi_top',
    });
    expect(stripe.chargeShortfall).toHaveBeenCalledWith({
      originalPaymentId: 'pi_1',
      method: { customerId: 'cus_1', methodId: 'pm_1' },
      capturedCents: 5000,
      finalCostCents: 7000,
      currency: 'EUR',
      feeTax: FEE_TAX,
      platformFeePercent: 5,
      description: 'Retry top-up for session s1',
      idempotencyKey: 'topup_retry_42_5000',
    });
    expect(h.sessionChargeTax).toHaveBeenCalledWith({
      finalCostCents: 7000,
      tariffTaxRate: '0.19',
      costBreakdown: { energy: 7000 },
    });
    expect(h.getPlatformFeePercent).toHaveBeenCalledWith('site1');
    expect(h.markShortfallRecovered).toHaveBeenCalledWith(42, {
      capturedCents: 7000,
      actorUserId: 'u1',
      actionReason: 'Operator retry top-up; recovered 2000c via pi_top',
      topUp: { paymentId: 'pi_top', amountCents: 2000 },
    });
  });

  it('omits the method without stored ids and falls back to the record', async () => {
    const rec = shortRecord({ capturedAmountCents: null, stripePaymentMethodId: null });
    h.findRecord.mockResolvedValue(rec);
    h.results.push([CHARGE]);
    expect(await retryShortfallForRecord(input, ctx)).toEqual({
      status: 'recovered',
      record: rec,
      shortfallCents: 7000,
      topUpId: 'pi_top',
    });
    const call = stripe.chargeShortfall.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(call).not.toHaveProperty('method');
    expect(call['idempotencyKey']).toBe('topup_retry_42_0');

    h.findRecord.mockResolvedValue(shortRecord({ stripeCustomerId: null }));
    h.results.push([CHARGE]);
    await retryShortfallForRecord(input, ctx);
    expect(stripe.chargeShortfall.mock.calls[1]?.[0]).not.toHaveProperty('method');
  });
});

describe('retryShortfalls', () => {
  it('retries each row, counts outcomes and records declines', async () => {
    h.execute.mockResolvedValue([
      { pr_id: 1, session_id: 's1' },
      { pr_id: 2, session_id: 's2' },
      { pr_id: 3, session_id: 's3' },
      { pr_id: 4, session_id: 's4' },
      { pr_id: 5, session_id: 's5' },
      { pr_id: 6, session_id: 's6' },
      { pr_id: 7, session_id: 's7' },
      { pr_id: 8, session_id: 's8' },
    ]);
    const records: Record<number, PaymentRecord | null> = {
      1: record({ id: 1, sessionId: 's1', status: 'captured' }),
      2: null,
      3: record({ id: 3, stripePaymentIntentId: null }),
      4: record({ id: 4, sessionId: 's4' }),
      5: record({ id: 5, sessionId: 's5', capturedAmountCents: null }),
      6: record({ id: 6, sessionId: 's6' }),
      7: record({ id: 7, sessionId: 's7' }),
      8: record({ id: 8, sessionId: 's8', stripePaymentIntentId: 'pi_sim_8' }),
    };
    h.findRecord.mockImplementation((id: number) => Promise.resolve(records[id] ?? null));
    h.results.push(
      [CHARGE], // 1: recovered
      [CHARGE], // 2: no record
      [CHARGE], // 3: no payment id
      [], // 4: no session charge
      [{ ...CHARGE, finalCostCents: null }], // 5: no shortfall
      [CHARGE], // 6: declined
      [CHARGE], // 7: declined, reason write fails
      [CHARGE], // 8: provider not configured
    );
    getPaymentProvider.mockImplementation((id: string) =>
      id === 'simulated'
        ? Promise.reject(new PaymentProviderNotConfiguredError('simulated'))
        : Promise.resolve(stripe),
    );
    stripe.chargeShortfall
      .mockResolvedValueOnce({ paymentId: 'pi_top1', amountCents: 2000, applicationFeeCents: 0 })
      .mockRejectedValueOnce(new Error('card_declined'))
      .mockRejectedValueOnce('weird');
    const updateErr = new Error('db down');
    h.markShortfallRetryFailed.mockResolvedValueOnce(true).mockRejectedValueOnce(updateErr);

    expect(await retryShortfalls(ctx)).toEqual({ total: 8, recovered: 1, stillFailed: 2 });

    expect(stripe.chargeShortfall).toHaveBeenCalledTimes(3);
    expect(stripe.chargeShortfall).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({
        description: 'Capture retry for session s1',
        idempotencyKey: 'topup_retry_1_5000',
      }),
    );
    expect(h.markShortfallRecovered).toHaveBeenCalledOnce();
    expect(h.markShortfallRecovered).toHaveBeenCalledWith(1, {
      capturedCents: 7000,
      actorUserId: null,
      actionReason: 'Cron retry top-up; recovered 2000c via pi_top1',
      topUp: { paymentId: 'pi_top1', amountCents: 2000 },
    });
    expect(logger.info).toHaveBeenCalledWith(
      { paymentRecordId: 1, shortfall: 2000, topUpIntentId: 'pi_top1' },
      'Recovered capture shortfall via cron retry',
    );
    expect(h.markShortfallRetryFailed).toHaveBeenCalledTimes(2);
    expect(h.markShortfallRetryFailed.mock.calls[0]?.[0]).toBe(6);
    expect(h.markShortfallRetryFailed.mock.calls[0]?.[1]).toMatch(
      /^Top-up declined: card_declined; shortfall 2000c \(last retry \d{4}-\d{2}-\d{2}T[\d:.]+Z\)$/,
    );
    expect(h.markShortfallRetryFailed.mock.calls[1]?.[1]).toMatch(
      /^Top-up declined: Unknown error; shortfall 2000c/,
    );
    expect(logger.warn).toHaveBeenCalledWith(
      { err: updateErr, paymentRecordId: 7 },
      'Failed to record the capture retry failure reason',
    );
    expect(logger.warn).toHaveBeenCalledWith(
      { paymentRecordId: 8, providerId: 'simulated' },
      'Payment provider not configured; cannot retry the shortfall',
    );
    expect(logger.warn).toHaveBeenCalledWith(
      expect.objectContaining({ paymentRecordId: 6, shortfall: 2000 }),
      'Capture retry failed; will try again next run',
    );
  });

  it('cuts the decline message to 350 characters', async () => {
    h.execute.mockResolvedValue([{ pr_id: 1, session_id: 's1' }]);
    h.findRecord.mockResolvedValue(record({ id: 1 }));
    h.results.push([CHARGE]);
    stripe.chargeShortfall.mockRejectedValue(new Error('m'.repeat(400)));
    expect(await retryShortfalls(ctx)).toEqual({ total: 1, recovered: 0, stillFailed: 1 });
    expect(h.markShortfallRetryFailed.mock.calls[0]?.[1]).toContain(
      `Top-up declined: ${'m'.repeat(350)}; shortfall`,
    );
  });

  it('returns zeros when nothing is due', async () => {
    h.execute.mockResolvedValue([]);
    expect(await retryShortfalls(ctx)).toEqual({ total: 0, recovered: 0, stillFailed: 0 });
  });
});

describe('settleSessionPayment', () => {
  const SESSION = {
    id: 's1',
    driverId: 'd1',
    isRoaming: false,
    freeVend: false,
    prepaid: false,
    finalCostCents: 4000,
    tariffTaxRate: '0.19',
    costBreakdown: { energy: 4000 },
    siteId: 'site1',
  };
  const hold = (overrides: Partial<PaymentRecord> = {}): PaymentRecord =>
    record({ preAuthAmountCents: 5000, capturedAmountCents: null, ...overrides });

  beforeEach(() => {
    h.findSessionHold.mockResolvedValue(hold());
    h.settlePrepaidSession.mockResolvedValue(null);
    h.markHoldFailed.mockResolvedValue(true);
  });

  it('returns none for an unknown session', async () => {
    h.results.push([]);
    expect(await settleSessionPayment('s1', ctx)).toEqual({ mode: 'none' });
    expect(h.findSessionHold).not.toHaveBeenCalled();
  });

  it('debits a prepaid token and returns the prepaid outcome', async () => {
    h.results.push([{ ...SESSION, prepaid: true }]);
    h.settlePrepaidSession.mockResolvedValue({
      tokenId: 't1',
      debitedCents: 4000,
      balanceCents: 1000,
    });
    expect(await settleSessionPayment('s1', ctx)).toEqual({
      mode: 'prepaid',
      tokenId: 't1',
      debitedCents: 4000,
      balanceCents: 1000,
    });
    expect(h.settlePrepaidSession).toHaveBeenCalledWith('s1', logger);
    expect(h.findSessionHold).not.toHaveBeenCalled();
    expect(h.selects[0]?.leftJoin).toEqual([
      { id: 't.id', prepaidBalanceCents: 't.prepaid_balance_cents' },
      { op: 'eq', col: 't.id', value: 'cs.token_id' },
    ]);
  });

  it('falls through to the hold when the prepaid debit settles nothing', async () => {
    h.results.push([{ ...SESSION, prepaid: true }]);
    h.findSessionHold.mockResolvedValue(null);
    expect(await settleSessionPayment('s1', ctx)).toEqual({ mode: 'none' });
    expect(h.settlePrepaidSession).toHaveBeenCalledOnce();
    expect(h.findSessionHold).toHaveBeenCalledWith('s1');
  });

  it('logs a failed prepaid debit and falls through to the hold', async () => {
    h.results.push([{ ...SESSION, prepaid: true }]);
    const err = new Error('tx failed');
    h.settlePrepaidSession.mockRejectedValue(err);
    h.findSessionHold.mockResolvedValue(null);
    expect(await settleSessionPayment('s1', ctx)).toEqual({ mode: 'none' });
    expect(logger.error).toHaveBeenCalledWith(
      { err, sessionId: 's1' },
      'Prepaid balance debit failed',
    );
  });

  it('does not try a prepaid debit for a card session', async () => {
    h.results.push([SESSION]);
    h.findSessionHold.mockResolvedValue(null);
    expect(await settleSessionPayment('s1', ctx)).toEqual({ mode: 'none' });
    expect(h.settlePrepaidSession).not.toHaveBeenCalled();
  });

  it('leaves a guest hold to the worker', async () => {
    h.results.push([SESSION]);
    h.findSessionHold.mockResolvedValue(hold({ driverId: null }));
    expect(await settleSessionPayment('s1', ctx)).toEqual({ mode: 'guest' });
  });

  it('returns none for a hold without a provider payment', async () => {
    h.results.push([SESSION]);
    h.findSessionHold.mockResolvedValue(hold({ stripePaymentIntentId: null }));
    expect(await settleSessionPayment('s1', ctx)).toEqual({ mode: 'none' });
    expect(getPaymentProvider).not.toHaveBeenCalled();
  });

  it('marks the hold failed when the provider is not configured', async () => {
    h.results.push([SESSION]);
    const err = new PaymentProviderNotConfiguredError('stripe');
    getPaymentProvider.mockRejectedValue(err);
    expect(await settleSessionPayment('s1', ctx)).toEqual({
      mode: 'card',
      status: 'failed',
      paymentRecordId: 42,
      driverId: 'd1',
      reason: 'Payment provider stripe is not configured',
    });
    expect(h.markHoldFailed).toHaveBeenCalledWith(42, 'Payment provider stripe is not configured');
    expect(logger.error).toHaveBeenCalledWith(
      { err, sessionId: 's1', paymentRecordId: 42 },
      'Auto capture/cancel failed',
    );
    expect(h.markCaptured).not.toHaveBeenCalled();
  });

  it('marks the hold failed on a capture error and logs a failed record write', async () => {
    h.results.push([SESSION]);
    stripe.capture.mockRejectedValue('weird');
    const dbErr = new Error('db down');
    h.markHoldFailed.mockRejectedValue(dbErr);
    expect(await settleSessionPayment('s1', ctx)).toMatchObject({
      status: 'failed',
      reason: 'Unknown capture error',
    });
    expect(h.markHoldFailed).toHaveBeenCalledWith(42, 'Unknown capture error');
    expect(logger.error).toHaveBeenCalledWith(
      { err: dbErr, paymentRecordId: 42 },
      'Failed to record capture failure',
    );
  });

  it.each([[null], [0]])('cancels the hold for a final cost of %s', async (finalCostCents) => {
    h.results.push([{ ...SESSION, finalCostCents }]);
    expect(await settleSessionPayment('s1', ctx)).toEqual({
      mode: 'card',
      status: 'cancelled',
      paymentRecordId: 42,
      recorded: true,
    });
    expect(stripe.cancelHold).toHaveBeenCalledWith({
      paymentId: 'pi_1',
      merchantReference: 'sess_s1',
      idempotencyKey: 'cancel_42',
    });
    expect(h.markCancelled).toHaveBeenCalledWith(42);
    expect(stripe.capture).not.toHaveBeenCalled();
  });

  it('warns when the cancelled record had moved on', async () => {
    h.results.push([{ ...SESSION, finalCostCents: 0 }]);
    h.markCancelled.mockResolvedValue(false);
    expect(await settleSessionPayment('s1', ctx)).toMatchObject({
      status: 'cancelled',
      recorded: false,
    });
    expect(logger.warn).toHaveBeenCalledWith(
      { paymentRecordId: 42, paymentId: 'pi_1' },
      'Payment settled at the provider but the record had moved on',
    );
  });

  it('captures the final cost within the hold', async () => {
    h.results.push([SESSION]);
    expect(await settleSessionPayment('s1', ctx)).toEqual({
      mode: 'card',
      status: 'captured',
      paymentRecordId: 42,
      driverId: 'd1',
      capturedCents: 4000,
      shortfallCents: 0,
      recorded: true,
    });
    expect(h.sessionChargeTax).toHaveBeenCalledWith({
      finalCostCents: 4000,
      tariffTaxRate: '0.19',
      costBreakdown: { energy: 4000 },
    });
    expect(h.getPlatformFeePercent).toHaveBeenCalledWith('site1');
    expect(stripe.capture).toHaveBeenCalledWith({
      paymentId: 'pi_1',
      amountCents: 4000,
      currency: 'EUR',
      merchantReference: 'sess_s1',
      payoutAccountId: null,
      feeTax: FEE_TAX,
      platformFeePercent: 5,
      idempotencyKey: 'capture_42',
    });
    expect(stripe.chargeShortfall).not.toHaveBeenCalled();
    expect(h.markCaptured).toHaveBeenCalledWith(42, {
      capturedCents: 4000,
      failureReason: null,
      topUp: null,
    });
  });

  it('captures the whole final cost when the hold amount is unknown', async () => {
    h.results.push([SESSION]);
    h.findSessionHold.mockResolvedValue(hold({ preAuthAmountCents: null }));
    expect(await settleSessionPayment('s1', ctx)).toMatchObject({ capturedCents: 4000 });
    expect(stripe.capture).toHaveBeenCalledWith(expect.objectContaining({ amountCents: 4000 }));
    expect(stripe.chargeShortfall).not.toHaveBeenCalled();
  });

  it('captures the hold and charges the rest as a top-up', async () => {
    h.results.push([{ ...SESSION, finalCostCents: 7000 }]);
    expect(await settleSessionPayment('s1', ctx)).toMatchObject({
      status: 'captured',
      capturedCents: 7000,
      shortfallCents: 0,
      recorded: true,
    });
    expect(stripe.capture).toHaveBeenCalledWith(expect.objectContaining({ amountCents: 5000 }));
    expect(stripe.chargeShortfall).toHaveBeenCalledWith({
      originalPaymentId: 'pi_1',
      method: { customerId: 'cus_1', methodId: 'pm_1' },
      capturedCents: 5000,
      finalCostCents: 7000,
      currency: 'EUR',
      feeTax: FEE_TAX,
      platformFeePercent: 5,
      description: 'Top-up for session s1',
      idempotencyKey: 'topup_42',
    });
    expect(h.markCaptured).toHaveBeenCalledWith(42, {
      capturedCents: 7000,
      failureReason: null,
      topUp: { paymentId: 'pi_top', amountCents: 2000 },
    });
  });

  it('omits the method of a top-up without stored ids', async () => {
    h.results.push([{ ...SESSION, finalCostCents: 7000 }], [{ ...SESSION, finalCostCents: 7000 }]);
    h.findSessionHold.mockResolvedValue(hold({ stripePaymentMethodId: null }));
    await settleSessionPayment('s1', ctx);
    h.findSessionHold.mockResolvedValue(hold({ stripeCustomerId: null }));
    await settleSessionPayment('s1', ctx);
    expect(stripe.chargeShortfall.mock.calls[0]?.[0]).not.toHaveProperty('method');
    expect(stripe.chargeShortfall.mock.calls[1]?.[0]).not.toHaveProperty('method');
  });

  it('records a declined top-up as a shortfall with the message cut to 350', async () => {
    h.results.push([{ ...SESSION, finalCostCents: 7000 }]);
    const err = new Error('z'.repeat(400));
    stripe.chargeShortfall.mockRejectedValue(err);
    expect(await settleSessionPayment('s1', ctx)).toMatchObject({
      status: 'captured',
      capturedCents: 5000,
      shortfallCents: 2000,
      recorded: true,
    });
    expect(h.markCaptured).toHaveBeenCalledWith(42, {
      capturedCents: 5000,
      failureReason: `Top-up declined: ${'z'.repeat(350)}; shortfall 2000c`,
      topUp: null,
    });
    expect(logger.warn).toHaveBeenCalledWith(
      { err, paymentRecordId: 42, deltaCents: 2000 },
      'Top-up failed; the hold was captured but the rest is uncollected',
    );
  });

  it('records a non-Error top-up failure', async () => {
    h.results.push([{ ...SESSION, finalCostCents: 7000 }]);
    stripe.chargeShortfall.mockRejectedValue('nope');
    await settleSessionPayment('s1', ctx);
    expect(h.markCaptured).toHaveBeenCalledWith(
      42,
      expect.objectContaining({ failureReason: 'Top-up failed; shortfall 2000c' }),
    );
  });

  it('warns when the captured record had moved on', async () => {
    h.results.push([SESSION]);
    h.markCaptured.mockResolvedValue(false);
    expect(await settleSessionPayment('s1', ctx)).toMatchObject({
      status: 'captured',
      recorded: false,
    });
    expect(logger.warn).toHaveBeenCalledWith(
      { paymentRecordId: 42, paymentId: 'pi_1' },
      'Payment settled at the provider but the record had moved on',
    );
  });

  it('logs a failed record update after the provider settled', async () => {
    h.results.push([SESSION]);
    const dbErr = new Error('db down');
    h.markCaptured.mockRejectedValue(dbErr);
    expect(await settleSessionPayment('s1', ctx)).toMatchObject({
      status: 'captured',
      capturedCents: 4000,
      recorded: false,
    });
    expect(logger.error).toHaveBeenCalledWith(
      { err: dbErr, paymentRecordId: 42, paymentId: 'pi_1', capturedCents: 4000 },
      'Payment settled at the provider but the record update failed; manual reconciliation required',
    );
  });
});
