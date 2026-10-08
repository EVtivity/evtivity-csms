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
    clearPendingAdjustment: vi.fn(),
    findRecord: vi.fn(),
    findSessionHold: vi.fn(),
    findSessionRecord: vi.fn(),
    markCancelled: vi.fn(),
    markCaptured: vi.fn(),
    markAdjustmentPending: vi.fn(),
    markHoldFailed: vi.fn(),
    setAdjustmentRef: vi.fn(),
    settlePrepaidSession: vi.fn(),
    markShortfallRecovered: vi.fn(),
    markShortfallRetryFailed: vi.fn(),
    staleAdjustmentClaims: vi.fn(),
    reclaimStaleAdjustment: vi.fn(),
    recordFailedHold: vi.fn(),
    recordHold: vi.fn(),
    sitePayoutReadiness: vi.fn(),
  };
});

vi.mock('@evtivity/database', async () => ({
  // The real Postgres error readers (lost connections are rethrown).
  ...(await vi.importActual<Record<string, unknown>>('../../../database/src/lib/pg-errors.js')),
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
    provider: 'm.provider',
    providerCustomerId: 'm.provider_customer_id',
    providerPaymentMethodId: 'm.provider_payment_method_id',
  },
  getPlatformFeePercent: h.getPlatformFeePercent,
}));
vi.mock('@evtivity/lib', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  sessionChargeTax: h.sessionChargeTax,
}));
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
vi.mock('../payout-accounts.js', () => ({
  PAYOUT_NOT_READY_FAILURE: 'Payout account not ready',
  PAYOUT_NOT_READY_REASON: 'This site cannot accept card payments yet',
  sitePayoutReadiness: h.sitePayoutReadiness,
}));
vi.mock('../payment-records.js', () => ({
  clearPendingAdjustment: h.clearPendingAdjustment,
  findRecord: h.findRecord,
  findSessionHold: h.findSessionHold,
  findSessionRecord: h.findSessionRecord,
  markCancelled: h.markCancelled,
  markCaptured: h.markCaptured,
  markAdjustmentPending: h.markAdjustmentPending,
  markHoldFailed: h.markHoldFailed,
  setAdjustmentRef: h.setAdjustmentRef,
  settlePrepaidSession: h.settlePrepaidSession,
  staleAdjustmentClaims: h.staleAdjustmentClaims,
  reclaimStaleAdjustment: h.reclaimStaleAdjustment,
  markShortfallRecovered: h.markShortfallRecovered,
  markShortfallRetryFailed: h.markShortfallRetryFailed,
  recordFailedHold: h.recordFailedHold,
  recordHold: h.recordHold,
}));

import {
  authorizeSessionHold,
  cancelOpenSessionHold,
  cancelSessionHold,
  captureSessionHold,
  belowMinimumCaptureReason,
  holdTerms,
  isReleasedBelowMinimum,
  retryShortfallForRecord,
  RESUME_ADJUSTMENT_MIN_AGE_MS,
  resumeStaleAdjustments,
  retryShortfalls,
  settleAdjustedHold,
  settleSessionPayment,
} from '../session-payments.js';
import { fakeAdyenProvider, MODIFICATION_PSP } from '../testing/fake-adyen.js';
import type { SessionHoldInput } from '../session-payments.js';
import {
  PaymentDeclinedError,
  PaymentProviderNotConfiguredError,
  PaymentProviderUnavailableError,
} from '../errors.js';
import type { PaymentContext } from '../context.js';
import type { PaymentRecord } from '../payment-records.js';
import type { PaymentProviderRegistry } from '../registry.js';

interface FakeProvider {
  id: string;
  capabilities: { shortfall: 'top_up' | 'adjust_hold' };
  adjustHold?: Mock<(input: unknown) => Promise<unknown>>;
  minimumChargeCents?: Mock<(currency: string) => number | null>;
  authorizeHold: Mock<(input: unknown) => Promise<unknown>>;
  cancelHold: Mock<(input: unknown) => Promise<unknown>>;
  capture: Mock<(input: unknown) => Promise<unknown>>;
  chargeShortfall: Mock<(input: unknown) => Promise<unknown>>;
}

function fakeProvider(id: string): FakeProvider {
  return {
    id,
    capabilities: { shortfall: 'top_up' },
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

// A postgres.js connection error (Errors.connection) or Node socket error.
function connectionError(code: string): Error {
  return Object.assign(new Error(`write ${code} localhost:5433`), { code });
}

// How the retried OCPP settlement calls it before its last run.
const RETRYING = { rethrowConnectionErrors: true, resumeAdjustment: false };

function record(overrides: Partial<PaymentRecord> = {}): PaymentRecord {
  return {
    id: 42,
    sessionId: 's1',
    driverId: 'd1',
    sitePaymentConfigId: null,
    invoiceId: null,
    provider: 'stripe',
    providerPaymentId: 'pi_1',
    providerCustomerId: 'cus_1',
    providerPaymentMethodId: 'pm_1',
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
    pendingOperation: null,
    pendingOperationRef: null,
    pendingOperationAt: null,
    providerRefunds: [],
    providerState: null,
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
  h.sitePayoutReadiness.mockResolvedValue('ready');
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
      payoutBlocked: false,
    });
    expect(h.getSitePaymentConfig).toHaveBeenCalledWith('site1');
    expect(h.sitePayoutReadiness).toHaveBeenCalledWith('site1', ctx);
    expect(settings).not.toHaveBeenCalled();
  });

  it('blocks the payout account when it is not ready (O5, fail closed)', async () => {
    h.getSitePaymentConfig.mockResolvedValue({
      configId: 3,
      payoutAccountId: 'acct_1',
      preAuthAmountCents: 9000,
    });
    h.sitePayoutReadiness.mockResolvedValue('not_ready');
    expect(await holdTerms(ctx, 'site1')).toEqual({
      preAuthAmountCents: 9000,
      sitePaymentConfigId: 3,
      payoutAccountId: null,
      payoutBlocked: true,
    });
  });

  it('does not check readiness for a site config without a payout account', async () => {
    h.getSitePaymentConfig.mockResolvedValue({
      configId: 3,
      payoutAccountId: null,
      preAuthAmountCents: 9000,
    });
    expect(await holdTerms(ctx, 'site1')).toMatchObject({
      payoutAccountId: null,
      payoutBlocked: false,
    });
    expect(h.sitePayoutReadiness).not.toHaveBeenCalled();
  });

  it('falls back to the global settings', async () => {
    expect(await holdTerms(ctx, 'site1')).toEqual({
      preAuthAmountCents: 2500,
      sitePaymentConfigId: null,
      payoutAccountId: null,
      payoutBlocked: false,
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
  const METHOD = { id: 5, provider: 'stripe', customerId: 'cus_1', methodId: 'pm_1' };

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

  it('pins the hold to the provider column of the method', async () => {
    h.results.push([{ ...METHOD, provider: 'simulated' }], [{ currency: 'EUR' }]);
    await authorizeSessionHold(input, ctx);
    expect(getPaymentProvider).toHaveBeenCalledWith('simulated');
    expect(simulated.authorizeHold).toHaveBeenCalledOnce();
    expect(stripe.authorizeHold).not.toHaveBeenCalled();
    expect(h.recordHold).toHaveBeenCalledWith(expect.objectContaining({ provider: 'simulated' }));
    expect(h.selects[0]?.fields).toEqual({
      id: 'm.id',
      provider: 'm.provider',
      customerId: 'm.provider_customer_id',
      methodId: 'm.provider_payment_method_id',
    });
  });

  it('returns not_configured for a method without a provider', async () => {
    h.results.push([{ ...METHOD, provider: null }]);
    expect(await authorizeSessionHold(input, ctx)).toEqual({
      outcome: 'not_configured',
      providerId: 'unknown',
    });
    expect(getPaymentProvider).not.toHaveBeenCalled();
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
      [{ id: 5, provider: 'simulated', customerId: 'cus_sim_1', methodId: 'pm_sim_1' }],
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
      provider: 'simulated',
      paymentId: 'pi_new',
      customerId: 'cus_sim_1',
      methodId: 'pm_sim_1',
      source: 'web_portal',
      currency: 'EUR',
      preAuthAmountCents: 9000,
      providerState: null,
    });
  });

  it('stores the provider state of the hold for a later adjustment', async () => {
    h.results.push(
      [{ id: 5, provider: 'simulated', customerId: 'cus_sim_1', methodId: 'pm_sim_1' }],
      [{ currency: 'EUR' }],
    );
    simulated.authorizeHold.mockResolvedValue({
      status: 'authorized',
      paymentId: 'pi_new',
      authorizedCents: 2500,
      providerState: { adjustAuthorisationData: 'BLOB' },
    });
    await authorizeSessionHold(
      { ...input, methodRowId: 5, siteId: null, trigger: 'portal_start' },
      ctx,
    );
    expect(h.recordHold).toHaveBeenCalledWith(
      expect.objectContaining({ providerState: { adjustAuthorisationData: 'BLOB' } }),
    );
  });

  it('refuses the hold without a provider call when the payout account is not ready', async () => {
    h.results.push([METHOD], [{ currency: 'EUR' }]);
    h.getSitePaymentConfig.mockResolvedValue({
      configId: 3,
      payoutAccountId: 'acct_1',
      preAuthAmountCents: 9000,
    });
    h.sitePayoutReadiness.mockResolvedValue('not_ready');

    const outcome = await authorizeSessionHold({ ...input, siteId: 'site1' }, ctx);

    expect(outcome).toEqual({
      outcome: 'declined',
      reason: 'This site cannot accept card payments yet',
      paymentRecordId: 78,
      failure: 'declined',
      code: 'payout_account_not_ready',
    });
    expect(stripe.authorizeHold).not.toHaveBeenCalled();
    expect(h.recordFailedHold).toHaveBeenCalledWith(
      expect.objectContaining({
        sessionId: 's1',
        sitePaymentConfigId: 3,
        reason: 'Payout account not ready',
      }),
    );
  });

  it('still returns the refusal when its record cannot be written', async () => {
    h.results.push([METHOD], [{ currency: 'EUR' }]);
    h.getSitePaymentConfig.mockResolvedValue({
      configId: 3,
      payoutAccountId: 'acct_1',
      preAuthAmountCents: 9000,
    });
    h.sitePayoutReadiness.mockResolvedValue('not_ready');
    h.recordFailedHold.mockRejectedValue(new Error('db down'));

    expect(await authorizeSessionHold({ ...input, siteId: 'site1' }, ctx)).toMatchObject({
      outcome: 'declined',
      paymentRecordId: null,
      code: 'payout_account_not_ready',
    });
    expect(logger.error).toHaveBeenCalled();
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
      failure: 'declined',
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
      failure: 'declined',
    });
    expect(h.recordFailedHold).toHaveBeenCalledWith({
      sessionId: 's1',
      driverId: 'd1',
      sitePaymentConfigId: null,
      provider: 'stripe',
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

  it('marks a provider failure apart from a card decline', async () => {
    h.results.push([METHOD], [{ currency: 'EUR' }]);
    stripe.authorizeHold.mockRejectedValue(new PaymentProviderUnavailableError('provider down'));
    expect(await authorizeSessionHold(input, ctx)).toEqual({
      outcome: 'declined',
      reason: 'provider down',
      paymentRecordId: 78,
      failure: 'provider_error',
    });
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
      failure: 'provider_error',
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
    h.findSessionHold.mockResolvedValue(record({ providerPaymentId: null }));
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
      idempotencyKey: 'capture_pi_1',
    });
    expect(h.markCaptured).toHaveBeenCalledWith(42, {
      capturedCents: 7000,
      failureReason: null,
      pendingRef: null,
    });
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
      idempotencyKey: 'cancel_pi_1',
    });
    expect(stripe.capture).not.toHaveBeenCalled();
    expect(h.markCancelled).toHaveBeenCalledWith(42, null);
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
    await cancelSessionHold(record({ providerPaymentId: null }), 'r', ctx);
    expect(getPaymentProvider).not.toHaveBeenCalled();
  });

  it('cancels with the session reference', async () => {
    await cancelSessionHold(record(), 'cost 0', ctx);
    expect(stripe.cancelHold).toHaveBeenCalledWith({
      paymentId: 'pi_1',
      merchantReference: 'sess_s1',
      idempotencyKey: 'cancel_pi_1',
    });
    expect(h.markCancelled).toHaveBeenCalledWith(42, null);
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

describe('cancelOpenSessionHold', () => {
  it('reports none without an open hold', async () => {
    h.findSessionHold.mockResolvedValue(null);
    expect(await cancelOpenSessionHold('s1', 'no EV', ctx)).toEqual({ status: 'none' });
    expect(getPaymentProvider).not.toHaveBeenCalled();
  });

  it('reports none for a hold without a provider payment', async () => {
    h.findSessionHold.mockResolvedValue(record({ providerPaymentId: null }));
    expect(await cancelOpenSessionHold('s1', 'no EV', ctx)).toEqual({ status: 'none' });
    expect(getPaymentProvider).not.toHaveBeenCalled();
  });

  it('cancels the open hold through its pinned provider, never a capture', async () => {
    h.findSessionHold.mockResolvedValue(record({ provider: 'simulated' }));
    h.markCancelled.mockResolvedValue(true);
    expect(await cancelOpenSessionHold('s1', 'no EV', ctx)).toEqual({
      status: 'cancelled',
      paymentRecordId: 42,
    });
    expect(h.findSessionHold).toHaveBeenCalledWith('s1');
    expect(simulated.cancelHold).toHaveBeenCalledWith({
      paymentId: 'pi_1',
      merchantReference: 'sess_s1',
      idempotencyKey: 'cancel_pi_1',
    });
    expect(simulated.capture).not.toHaveBeenCalled();
    expect(h.markCancelled).toHaveBeenCalledWith(42, null);
  });

  it('throws a provider error to the caller', async () => {
    h.findSessionHold.mockResolvedValue(record());
    stripe.cancelHold.mockRejectedValueOnce(new Error('provider down'));
    await expect(cancelOpenSessionHold('s1', 'no EV', ctx)).rejects.toThrow('provider down');
    expect(h.markCancelled).not.toHaveBeenCalled();
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
    h.findRecord.mockResolvedValue(shortRecord({ providerPaymentId: null }));
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

  it('answers not_recoverable for a shortfall below the provider minimum', async () => {
    h.findRecord.mockResolvedValue(shortRecord());
    h.results.push([CHARGE]);
    stripe.minimumChargeCents = vi.fn(() => 2001);
    expect(await retryShortfallForRecord(input, ctx)).toEqual({
      status: 'not_recoverable',
      reason:
        'Top-up below the provider minimum charge (2001c EUR); shortfall 2000c not collectable',
    });
    expect(stripe.minimumChargeCents).toHaveBeenCalledWith('EUR');
    expect(stripe.chargeShortfall).not.toHaveBeenCalled();
  });

  it('charges a shortfall at exactly the provider minimum', async () => {
    h.findRecord.mockResolvedValue(shortRecord());
    h.results.push([CHARGE]);
    stripe.minimumChargeCents = vi.fn(() => 2000);
    expect(await retryShortfallForRecord(input, ctx)).toMatchObject({ status: 'recovered' });
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
      idempotencyKey: 'topup_retry_pi_1_5000',
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
    const rec = shortRecord({ capturedAmountCents: null, providerPaymentMethodId: null });
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
    expect(call['idempotencyKey']).toBe('topup_retry_pi_1_0');

    h.findRecord.mockResolvedValue(shortRecord({ providerCustomerId: null }));
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
      3: record({ id: 3, providerPaymentId: null }),
      4: record({ id: 4, sessionId: 's4' }),
      5: record({ id: 5, sessionId: 's5', capturedAmountCents: null }),
      6: record({ id: 6, sessionId: 's6' }),
      7: record({ id: 7, sessionId: 's7' }),
      8: record({ id: 8, sessionId: 's8', providerPaymentId: 'pi_sim_8', provider: 'simulated' }),
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

    expect(await retryShortfalls(ctx)).toEqual({
      total: 8,
      recovered: 1,
      stillFailed: 2,
      notCollectable: 0,
    });

    expect(stripe.chargeShortfall).toHaveBeenCalledTimes(3);
    expect(stripe.chargeShortfall).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({
        description: 'Capture retry for session s1',
        idempotencyKey: 'topup_retry_pi_1_5000',
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
    expect(await retryShortfalls(ctx)).toEqual({
      total: 1,
      recovered: 0,
      stillFailed: 1,
      notCollectable: 0,
    });
    expect(h.markShortfallRetryFailed.mock.calls[0]?.[1]).toContain(
      `Top-up declined: ${'m'.repeat(350)}; shortfall`,
    );
  });

  it('closes a shortfall below the provider minimum without charging it', async () => {
    h.execute.mockResolvedValue([{ pr_id: 1, session_id: 's1' }]);
    h.findRecord.mockResolvedValue(record({ id: 1 }));
    h.results.push([CHARGE]);
    stripe.minimumChargeCents = vi.fn(() => 5000);
    expect(await retryShortfalls(ctx)).toEqual({
      total: 1,
      recovered: 0,
      stillFailed: 0,
      notCollectable: 1,
    });
    expect(stripe.chargeShortfall).not.toHaveBeenCalled();
    const reason = h.markShortfallRetryFailed.mock.calls[0]?.[1] as string;
    expect(reason).toBe(
      'Top-up below the provider minimum charge (5000c EUR); shortfall 2000c not collectable',
    );
    // Not a "Top-up declined:" reason, so the daily query no longer selects it.
    expect(reason.startsWith('Top-up declined:')).toBe(false);
  });

  it('returns zeros when nothing is due', async () => {
    h.execute.mockResolvedValue([]);
    expect(await retryShortfalls(ctx)).toEqual({
      total: 0,
      recovered: 0,
      stillFailed: 0,
      notCollectable: 0,
    });
  });
});

describe('isReleasedBelowMinimum', () => {
  it('is true only for a hold released below the provider minimum', () => {
    const reason = belowMinimumCaptureReason(22, 50, 'usd');
    expect(reason).toBe(
      'Capture below the provider minimum charge (50c USD); 22c not collectable, hold released',
    );
    expect(isReleasedBelowMinimum({ status: 'cancelled', failureReason: reason })).toBe(true);
    expect(isReleasedBelowMinimum({ status: 'cancelled', failureReason: null })).toBe(false);
    expect(isReleasedBelowMinimum({ status: 'failed', failureReason: reason })).toBe(false);
    expect(
      isReleasedBelowMinimum({
        status: 'captured',
        failureReason:
          'Top-up below the provider minimum charge (50c USD); shortfall 2c not collectable',
      }),
    ).toBe(false);
  });
});

describe('settleSessionPayment', () => {
  const SESSION = {
    id: 's1',
    driverId: 'd1',
    isRoaming: false,
    freeVend: false,
    prepaid: false,
    account: false,
    billingFleetId: null,
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

  it('throws a lost connection in the prepaid debit for the caller to retry', async () => {
    h.results.push([{ ...SESSION, prepaid: true }]);
    const err = connectionError('ECONNRESET');
    h.settlePrepaidSession.mockRejectedValue(err);
    await expect(settleSessionPayment('s1', ctx, RETRYING)).rejects.toBe(err);
    expect(h.findSessionHold).not.toHaveBeenCalled();
    expect(logger.error).not.toHaveBeenCalled();
  });

  it('throws a lost connection before the provider is asked, leaving the hold open', async () => {
    h.results.push([SESSION]);
    const err = connectionError('CONNECT_TIMEOUT');
    h.getPlatformFeePercent.mockRejectedValueOnce(err);
    await expect(settleSessionPayment('s1', ctx, RETRYING)).rejects.toBe(err);
    expect(stripe.capture).not.toHaveBeenCalled();
    expect(h.markHoldFailed).not.toHaveBeenCalled();
  });

  it('keeps the behavior without retry by default: a lost connection fails the hold', async () => {
    h.results.push([SESSION]);
    h.getPlatformFeePercent.mockRejectedValueOnce(connectionError('CONNECT_TIMEOUT'));
    expect(await settleSessionPayment('s1', ctx)).toMatchObject({ status: 'failed' });
    expect(h.markHoldFailed).toHaveBeenCalledOnce();
  });

  it('logs a lost connection in the prepaid debit by default and falls through', async () => {
    h.results.push([{ ...SESSION, prepaid: true }]);
    h.settlePrepaidSession.mockRejectedValue(connectionError('ECONNRESET'));
    h.findSessionHold.mockResolvedValue(null);
    expect(await settleSessionPayment('s1', ctx)).toEqual({ mode: 'none' });
    expect(logger.error).toHaveBeenCalledWith(
      expect.objectContaining({ sessionId: 's1' }),
      'Prepaid balance debit failed',
    );
  });

  it('records a failure after the provider was asked, whatever the error', async () => {
    h.results.push([SESSION]);
    stripe.capture.mockRejectedValue(connectionError('ECONNRESET'));
    expect(await settleSessionPayment('s1', ctx)).toMatchObject({ status: 'failed' });
    expect(h.markHoldFailed).toHaveBeenCalledOnce();
  });

  it('never captures twice when run again after the capture record failed', async () => {
    // First run: captured at the provider, the record update lost its connection.
    h.results.push([SESSION]);
    h.markCaptured.mockRejectedValueOnce(connectionError('ECONNRESET'));
    expect(await settleSessionPayment('s1', ctx)).toMatchObject({
      status: 'captured',
      recorded: false,
    });
    // The update committed: the hold is no longer pre_authorized, so the
    // rerun finds no open hold and asks the provider nothing.
    h.results.push([SESSION]);
    h.findSessionHold.mockResolvedValueOnce(null);
    expect(await settleSessionPayment('s1', ctx)).toEqual({ mode: 'none' });
    expect(stripe.capture).toHaveBeenCalledOnce();
    // The update did not commit: the rerun captures with the same key, which
    // the provider answers from the first capture.
    h.results.push([SESSION]);
    await settleSessionPayment('s1', ctx);
    const keys = stripe.capture.mock.calls.map(
      (call) => (call[0] as { idempotencyKey: string }).idempotencyKey,
    );
    expect(keys).toEqual(['capture_pi_1', 'capture_pi_1']);
  });

  it('does not try a prepaid debit for a card session', async () => {
    h.results.push([SESSION]);
    h.findSessionHold.mockResolvedValue(null);
    expect(await settleSessionPayment('s1', ctx)).toEqual({ mode: 'none' });
    expect(h.settlePrepaidSession).not.toHaveBeenCalled();
  });

  it('returns account for an account session without a provider call or record', async () => {
    h.results.push([{ ...SESSION, account: true, billingFleetId: 'flt_1' }]);
    h.findSessionHold.mockResolvedValue(null);
    expect(await settleSessionPayment('s1', ctx)).toEqual({
      mode: 'account',
      billingFleetId: 'flt_1',
    });
    expect(h.settlePrepaidSession).not.toHaveBeenCalled();
    expect(getPaymentProvider).not.toHaveBeenCalled();
  });

  it('still settles an open hold on an account session (it must not stay held)', async () => {
    h.results.push([{ ...SESSION, account: true, billingFleetId: 'flt_1' }]);
    expect(await settleSessionPayment('s1', ctx)).toMatchObject({
      mode: 'card',
      status: 'captured',
    });
  });

  it('settles a prepaid session of an account driver as prepaid', async () => {
    h.results.push([{ ...SESSION, prepaid: true, account: false }]);
    h.findSessionHold.mockResolvedValue(null);
    expect(await settleSessionPayment('s1', ctx)).toEqual({ mode: 'none' });
    expect(h.settlePrepaidSession).toHaveBeenCalled();
  });

  it('leaves a guest hold to the worker', async () => {
    h.results.push([SESSION]);
    h.findSessionHold.mockResolvedValue(hold({ driverId: null }));
    expect(await settleSessionPayment('s1', ctx)).toEqual({ mode: 'guest' });
  });

  it('returns none for a hold without a provider payment', async () => {
    h.results.push([SESSION]);
    h.findSessionHold.mockResolvedValue(hold({ providerPaymentId: null }));
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
      idempotencyKey: 'cancel_pi_1',
    });
    expect(h.markCancelled).toHaveBeenCalledWith(42, null, null);
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

  it('releases the hold of a final cost below the provider minimum', async () => {
    h.results.push([{ ...SESSION, finalCostCents: 22 }]);
    stripe.minimumChargeCents = vi.fn(() => 50);
    expect(await settleSessionPayment('s1', ctx)).toEqual({
      mode: 'card',
      status: 'cancelled',
      paymentRecordId: 42,
      recorded: true,
    });
    expect(stripe.capture).not.toHaveBeenCalled();
    expect(stripe.cancelHold).toHaveBeenCalledWith({
      paymentId: 'pi_1',
      merchantReference: 'sess_s1',
      idempotencyKey: 'cancel_pi_1',
    });
    expect(h.markCancelled).toHaveBeenCalledWith(
      42,
      null,
      'Capture below the provider minimum charge (50c EUR); 22c not collectable, hold released',
    );
    expect(h.markHoldFailed).not.toHaveBeenCalled();
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
      idempotencyKey: 'capture_pi_1',
    });
    expect(stripe.chargeShortfall).not.toHaveBeenCalled();
    expect(h.markCaptured).toHaveBeenCalledWith(42, {
      capturedCents: 4000,
      failureReason: null,
      topUp: null,
      pendingRef: null,
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
      idempotencyKey: 'topup_pi_1',
    });
    expect(h.markCaptured).toHaveBeenCalledWith(42, {
      capturedCents: 7000,
      failureReason: null,
      topUp: { paymentId: 'pi_top', amountCents: 2000 },
      pendingRef: null,
    });
  });

  it('omits the method of a top-up without stored ids', async () => {
    h.results.push([{ ...SESSION, finalCostCents: 7000 }], [{ ...SESSION, finalCostCents: 7000 }]);
    h.findSessionHold.mockResolvedValue(hold({ providerPaymentMethodId: null }));
    await settleSessionPayment('s1', ctx);
    h.findSessionHold.mockResolvedValue(hold({ providerCustomerId: null }));
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
      pendingRef: null,
    });
    expect(logger.warn).toHaveBeenCalledWith(
      { err, paymentRecordId: 42, deltaCents: 2000 },
      'Top-up failed; the hold was captured but the rest is uncollected',
    );
  });

  it('captures the hold and leaves a shortfall below the provider minimum uncharged', async () => {
    h.results.push([{ ...SESSION, finalCostCents: 7000 }]);
    stripe.minimumChargeCents = vi.fn(() => 2500);
    expect(await settleSessionPayment('s1', ctx)).toMatchObject({
      status: 'captured',
      capturedCents: 5000,
      shortfallCents: 2000,
    });
    expect(stripe.chargeShortfall).not.toHaveBeenCalled();
    expect(h.markCaptured).toHaveBeenCalledWith(
      42,
      expect.objectContaining({
        capturedCents: 5000,
        failureReason:
          'Top-up below the provider minimum charge (2500c EUR); shortfall 2000c not collectable',
        topUp: null,
      }),
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

describe('async providers record pending captures and cancels (P10a)', () => {
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

  beforeEach(() => {
    h.findSessionHold.mockResolvedValue(record({ preAuthAmountCents: 5000 }));
    h.settlePrepaidSession.mockResolvedValue(null);
    stripe.capture.mockResolvedValue({ state: 'pending', operationRef: 'CAP1' });
    stripe.cancelHold.mockResolvedValue({ state: 'pending', operationRef: 'CXL1' });
  });

  it('settlement records an optimistic capture with its pending reference', async () => {
    h.results.push([SESSION]);
    expect(await settleSessionPayment('s1', ctx)).toMatchObject({
      mode: 'card',
      status: 'captured',
      capturedCents: 4000,
      recorded: true,
    });
    expect(h.markCaptured).toHaveBeenCalledWith(42, {
      capturedCents: 4000,
      failureReason: null,
      topUp: null,
      pendingRef: 'CAP1',
    });
  });

  it('settlement records an optimistic cancel with its pending reference', async () => {
    h.results.push([{ ...SESSION, finalCostCents: 0 }]);
    expect(await settleSessionPayment('s1', ctx)).toMatchObject({ status: 'cancelled' });
    expect(h.markCancelled).toHaveBeenCalledWith(42, 'CXL1', null);
  });

  it('an operator capture and cancel record their pending references', async () => {
    h.results.push([CHARGE]);
    await captureSessionHold({ sessionId: 's1', amountCents: 3000 }, ctx);
    expect(h.markCaptured).toHaveBeenCalledWith(42, {
      capturedCents: 3000,
      failureReason: null,
      pendingRef: 'CAP1',
    });
    h.results.push([CHARGE]);
    await captureSessionHold({ sessionId: 's1', amountCents: 0 }, ctx);
    expect(h.markCancelled).toHaveBeenCalledWith(42, 'CXL1');
  });

  it('cancelSessionHold records the pending cancel', async () => {
    await cancelSessionHold(record(), 'given up', ctx);
    expect(h.markCancelled).toHaveBeenCalledWith(42, 'CXL1');
  });
});

describe('authorisation adjustment of a hold below the final cost (P10 Part D)', () => {
  const SESSION = {
    id: 's1',
    driverId: 'd1',
    isRoaming: false,
    freeVend: false,
    prepaid: false,
    finalCostCents: 7000,
    tariffTaxRate: '0.19',
    costBreakdown: { energy: 7000 },
    siteId: 'site1',
  };
  const hold = (overrides: Partial<PaymentRecord> = {}): PaymentRecord =>
    record({ preAuthAmountCents: 5000, capturedAmountCents: null, ...overrides });
  let order: string[];
  let adjustHold: Mock<(input: unknown) => Promise<unknown>>;

  beforeEach(() => {
    order = [];
    adjustHold = vi.fn(() => {
      order.push('adjustHold');
      return Promise.resolve({ state: 'succeeded', authorizedCents: 7000 });
    });
    stripe.capabilities = { shortfall: 'adjust_hold' };
    stripe.adjustHold = adjustHold;
    h.findSessionHold.mockResolvedValue(hold());
    h.settlePrepaidSession.mockResolvedValue(null);
    h.markHoldFailed.mockResolvedValue(true);
    h.markAdjustmentPending.mockImplementation(() => {
      order.push('markAdjustmentPending');
      return Promise.resolve(true);
    });
    h.setAdjustmentRef.mockResolvedValue(true);
    h.clearPendingAdjustment.mockResolvedValue(true);
  });

  it('throws a lost connection on the adjustment claim before the provider is asked', async () => {
    h.results.push([SESSION]);
    const err = connectionError('CONNECT_TIMEOUT');
    h.markAdjustmentPending.mockRejectedValueOnce(err);
    await expect(settleSessionPayment('s1', ctx, RETRYING)).rejects.toBe(err);
    expect(adjustHold).not.toHaveBeenCalled();
    expect(stripe.capture).not.toHaveBeenCalled();
    expect(h.markHoldFailed).not.toHaveBeenCalled();
  });

  it('leaves a claimed adjustment to its webhook on a first run', async () => {
    h.results.push([SESSION]);
    h.findSessionHold.mockResolvedValue(hold({ pendingOperation: 'adjust' }));
    expect(await settleSessionPayment('s1', ctx, RETRYING)).toMatchObject({
      status: 'adjusting',
    });
    expect(adjustHold).not.toHaveBeenCalled();
  });

  it('resumes a claimed adjustment without a reference on a rerun, with the same key', async () => {
    h.results.push([SESSION]);
    h.findSessionHold.mockResolvedValue(hold({ pendingOperation: 'adjust' }));
    h.reclaimStaleAdjustment.mockResolvedValueOnce(hold({ pendingOperation: 'adjust' }));
    expect(
      await settleSessionPayment('s1', ctx, {
        rethrowConnectionErrors: true,
        resumeAdjustment: true,
      }),
    ).toMatchObject({ status: 'captured', capturedCents: 7000 });
    expect(h.markAdjustmentPending).not.toHaveBeenCalled();
    expect(adjustHold).toHaveBeenCalledWith(
      expect.objectContaining({ idempotencyKey: 'adjust_pi_1_7000' }),
    );
  });

  it('does not resume a fresh claim on a rerun: its owner may still be settling it', async () => {
    h.results.push([SESSION]);
    h.findSessionHold.mockResolvedValue(hold({ pendingOperation: 'adjust' }));
    h.reclaimStaleAdjustment.mockResolvedValueOnce(null);
    const before = Date.now();
    expect(
      await settleSessionPayment('s1', ctx, {
        rethrowConnectionErrors: true,
        resumeAdjustment: true,
      }),
    ).toMatchObject({ status: 'adjusting' });
    expect(adjustHold).not.toHaveBeenCalled();
    const [id, olderThan] = h.reclaimStaleAdjustment.mock.calls[0] as [number, Date];
    expect(id).toBe(42);
    expect(before - olderThan.getTime()).toBeGreaterThanOrEqual(RESUME_ADJUSTMENT_MIN_AGE_MS - 50);
  });

  it('does not resume an adjustment that has its provider reference', async () => {
    h.results.push([SESSION]);
    h.findSessionHold.mockResolvedValue(
      hold({ pendingOperation: 'adjust', pendingOperationRef: 'PSP1' }),
    );
    expect(
      await settleSessionPayment('s1', ctx, {
        rethrowConnectionErrors: true,
        resumeAdjustment: true,
      }),
    ).toMatchObject({ status: 'adjusting' });
    expect(adjustHold).not.toHaveBeenCalled();
  });

  it('keeps the claim when the reference of an accepted adjustment cannot be stored', async () => {
    h.results.push([SESSION]);
    adjustHold.mockResolvedValueOnce({ state: 'pending', operationRef: 'PSP1' });
    h.setAdjustmentRef.mockRejectedValueOnce(connectionError('ECONNRESET'));
    expect(await settleSessionPayment('s1', ctx, RETRYING)).toMatchObject({
      status: 'adjusting',
    });
    expect(h.clearPendingAdjustment).not.toHaveBeenCalled();
    expect(stripe.capture).not.toHaveBeenCalled();
    expect(logger.warn).toHaveBeenCalledWith(
      expect.objectContaining({ paymentRecordId: 42, operationRef: 'PSP1' }),
      'Adjustment reference not stored; the claim stays for its webhook or the reconciliation',
    );
  });

  it('raises the hold synchronously and captures the whole final cost', async () => {
    h.results.push([SESSION]);
    h.findSessionHold.mockResolvedValue(
      hold({ providerState: { adjustAuthorisationData: 'BLOB' } }),
    );
    expect(await settleSessionPayment('s1', ctx)).toMatchObject({
      status: 'captured',
      capturedCents: 7000,
      shortfallCents: 0,
      recorded: true,
    });
    expect(order).toEqual(['markAdjustmentPending', 'adjustHold']);
    expect(adjustHold).toHaveBeenCalledWith({
      paymentId: 'pi_1',
      newTotalCents: 7000,
      currency: 'EUR',
      providerState: { adjustAuthorisationData: 'BLOB' },
      idempotencyKey: 'adjust_pi_1_7000',
    });
    expect(stripe.capture).toHaveBeenCalledWith(
      expect.objectContaining({ amountCents: 7000, idempotencyKey: 'capture_pi_1' }),
    );
    expect(stripe.chargeShortfall).not.toHaveBeenCalled();
    expect(h.markCaptured).toHaveBeenCalledWith(42, {
      capturedCents: 7000,
      failureReason: null,
      topUp: null,
      pendingRef: null,
      authorizedCents: 7000,
    });
  });

  it('leaves the hold open with its pending adjustment on an async answer', async () => {
    h.results.push([SESSION]);
    adjustHold.mockResolvedValue({ state: 'pending', operationRef: 'ADJ1' });
    expect(await settleSessionPayment('s1', ctx)).toEqual({
      mode: 'card',
      status: 'adjusting',
      paymentRecordId: 42,
      driverId: 'd1',
    });
    expect(adjustHold.mock.calls[0]?.[0]).not.toHaveProperty('providerState');
    expect(h.setAdjustmentRef).toHaveBeenCalledWith(42, 'ADJ1');
    expect(stripe.capture).not.toHaveBeenCalled();
    expect(h.markCaptured).not.toHaveBeenCalled();
  });

  it('logs an adjustment its webhook settled before the reference was stored', async () => {
    h.results.push([SESSION]);
    adjustHold.mockResolvedValue({ state: 'pending', operationRef: 'ADJ1' });
    h.setAdjustmentRef.mockResolvedValue(false);
    expect(await settleSessionPayment('s1', ctx)).toMatchObject({ status: 'adjusting' });
    expect(logger.info).toHaveBeenCalledWith(
      { paymentRecordId: 42, operationRef: 'ADJ1' },
      'Adjustment settled by its webhook before its reference was stored',
    );
  });

  it('falls back to the hold and a top-up when the adjustment is refused', async () => {
    h.results.push([SESSION]);
    const err = new PaymentDeclinedError('Refused');
    adjustHold.mockRejectedValue(err);
    expect(await settleSessionPayment('s1', ctx)).toMatchObject({
      status: 'captured',
      capturedCents: 7000,
      shortfallCents: 0,
    });
    expect(h.clearPendingAdjustment).toHaveBeenCalledWith(42);
    expect(stripe.capture).toHaveBeenCalledWith(expect.objectContaining({ amountCents: 5000 }));
    expect(stripe.chargeShortfall).toHaveBeenCalledWith(
      expect.objectContaining({ capturedCents: 5000, idempotencyKey: 'topup_pi_1' }),
    );
    expect(logger.warn).toHaveBeenCalledWith(
      { err, paymentRecordId: 42, finalCostCents: 7000, holdCents: 5000 },
      'Authorisation adjustment failed; capturing the hold and charging the rest as a top-up',
    );
  });

  it('still settles when the claim cannot be cleared after a refusal', async () => {
    h.results.push([SESSION]);
    adjustHold.mockRejectedValue(new PaymentDeclinedError('Refused'));
    const dbErr = new Error('db down');
    h.clearPendingAdjustment.mockRejectedValue(dbErr);
    expect(await settleSessionPayment('s1', ctx)).toMatchObject({ status: 'captured' });
    expect(logger.warn).toHaveBeenCalledWith(
      { err: dbErr, paymentRecordId: 42 },
      'Failed to clear the pending adjustment',
    );
  });

  it('leaves a hold another settlement is adjusting to its webhook', async () => {
    h.results.push([SESSION]);
    h.markAdjustmentPending.mockResolvedValue(false);
    expect(await settleSessionPayment('s1', ctx)).toMatchObject({ status: 'adjusting' });
    expect(adjustHold).not.toHaveBeenCalled();
    expect(stripe.capture).not.toHaveBeenCalled();
  });

  it('does not settle a hold whose adjustment is pending', async () => {
    h.results.push([SESSION]);
    h.findSessionHold.mockResolvedValue(hold({ pendingOperation: 'adjust' }));
    expect(await settleSessionPayment('s1', ctx)).toEqual({
      mode: 'card',
      status: 'adjusting',
      paymentRecordId: 42,
      driverId: 'd1',
    });
    expect(getPaymentProvider).not.toHaveBeenCalled();
  });

  it('does not adjust a hold that covers the final cost', async () => {
    h.results.push([{ ...SESSION, finalCostCents: 4000 }]);
    await settleSessionPayment('s1', ctx);
    expect(h.markAdjustmentPending).not.toHaveBeenCalled();
    expect(adjustHold).not.toHaveBeenCalled();
    expect(stripe.capture).toHaveBeenCalledWith(expect.objectContaining({ amountCents: 4000 }));
  });

  it('tops up without adjusting when the provider does not adjust holds', async () => {
    h.results.push([SESSION]);
    stripe.capabilities = { shortfall: 'top_up' };
    await settleSessionPayment('s1', ctx);
    expect(adjustHold).not.toHaveBeenCalled();
    expect(stripe.chargeShortfall).toHaveBeenCalled();
  });

  describe('settleAdjustedHold', () => {
    it('captures the final cost after a successful adjustment', async () => {
      h.results.push([SESSION]);
      expect(
        await settleAdjustedHold(
          hold({ pendingOperation: 'adjust' }),
          { success: true, authorizedCents: 7000 },
          ctx,
        ),
      ).toMatchObject({ status: 'captured', capturedCents: 7000, recorded: true });
      expect(adjustHold).not.toHaveBeenCalled();
      expect(stripe.capture).toHaveBeenCalledWith(
        expect.objectContaining({ amountCents: 7000, idempotencyKey: 'capture_pi_1' }),
      );
      expect(stripe.chargeShortfall).not.toHaveBeenCalled();
      expect(h.markCaptured).toHaveBeenCalledWith(
        42,
        expect.objectContaining({ capturedCents: 7000, authorizedCents: 7000 }),
      );
    });

    it('captures the hold and tops up the rest after a refused adjustment', async () => {
      h.results.push([SESSION]);
      expect(
        await settleAdjustedHold(hold(), { success: false, authorizedCents: 0 }, ctx),
      ).toMatchObject({ status: 'captured', capturedCents: 7000 });
      expect(stripe.capture).toHaveBeenCalledWith(expect.objectContaining({ amountCents: 5000 }));
      expect(stripe.chargeShortfall).toHaveBeenCalledWith(
        expect.objectContaining({ idempotencyKey: 'topup_pi_1' }),
      );
      expect(h.markCaptured).toHaveBeenCalledWith(42, {
        capturedCents: 7000,
        failureReason: null,
        topUp: { paymentId: 'pi_top', amountCents: 2000 },
        pendingRef: null,
      });
    });

    it('never captures less than the original hold covers', async () => {
      h.results.push([SESSION]);
      await settleAdjustedHold(hold(), { success: true, authorizedCents: 100 }, ctx);
      expect(stripe.capture).toHaveBeenCalledWith(expect.objectContaining({ amountCents: 5000 }));
    });

    it('marks the hold failed when the capture fails', async () => {
      h.results.push([SESSION]);
      stripe.capture.mockRejectedValue(new Error('capture refused'));
      expect(
        await settleAdjustedHold(hold(), { success: true, authorizedCents: 7000 }, ctx),
      ).toEqual({
        mode: 'card',
        status: 'failed',
        paymentRecordId: 42,
        driverId: 'd1',
        reason: 'capture refused',
      });
      expect(h.markHoldFailed).toHaveBeenCalledWith(42, 'capture refused');
    });

    it('settles nothing without a session, a driver or a payment', async () => {
      const adjustment = { success: true, authorizedCents: 7000 };
      expect(await settleAdjustedHold(hold({ sessionId: null }), adjustment, ctx)).toEqual({
        mode: 'none',
      });
      expect(await settleAdjustedHold(hold({ driverId: null }), adjustment, ctx)).toEqual({
        mode: 'none',
      });
      expect(await settleAdjustedHold(hold({ providerPaymentId: null }), adjustment, ctx)).toEqual({
        mode: 'none',
      });
      h.results.push([]);
      expect(await settleAdjustedHold(hold(), adjustment, ctx)).toEqual({ mode: 'none' });
      expect(stripe.capture).not.toHaveBeenCalled();
    });

    it('takes the final cost as the hold when the hold amount is unknown', async () => {
      h.results.push([SESSION]);
      await settleAdjustedHold(
        hold({ preAuthAmountCents: null }),
        { success: false, authorizedCents: 0 },
        ctx,
      );
      expect(stripe.capture).toHaveBeenCalledWith(expect.objectContaining({ amountCents: 7000 }));
    });
  });
});

describe('resumeStaleAdjustments', () => {
  const SESSION = {
    id: 's1',
    driverId: 'd1',
    isRoaming: false,
    freeVend: false,
    prepaid: false,
    finalCostCents: 7000,
    tariffTaxRate: '0.19',
    costBreakdown: { energy: 7000 },
    siteId: 'site1',
  };
  const claim = (overrides: Partial<PaymentRecord> = {}): PaymentRecord =>
    record({
      provider: 'adyen',
      providerPaymentId: 'KHQC5N7G84BLNK43',
      preAuthAmountCents: 5000,
      capturedAmountCents: null,
      pendingOperation: 'adjust',
      pendingOperationRef: null,
      pendingOperationAt: new Date(Date.now() - 2 * 3600_000),
      ...overrides,
    });
  const syncAdjust = () =>
    vi.fn(() => Promise.resolve({ state: 'succeeded', authorizedCents: 7000 }));

  // The atomic take-over: each claim can be taken once.
  let taken: Set<number>;

  beforeEach(() => {
    h.setAdjustmentRef.mockResolvedValue(true);
    h.clearPendingAdjustment.mockResolvedValue(true);
    h.markHoldFailed.mockResolvedValue(true);
    taken = new Set();
    h.reclaimStaleAdjustment.mockImplementation((id: number) => {
      if (taken.has(id)) return Promise.resolve(null);
      taken.add(id);
      return Promise.resolve(claim({ id }));
    });
  });

  it('re-drives a claim once when two reconciliations run together', async () => {
    h.staleAdjustmentClaims.mockResolvedValue([claim()]);
    stripe.capabilities = { shortfall: 'adjust_hold' };
    stripe.adjustHold = syncAdjust();
    h.results.push([SESSION], [SESSION]);
    const [a, b] = await Promise.all([resumeStaleAdjustments(ctx), resumeStaleAdjustments(ctx)]);
    expect(a.resumed + b.resumed).toBe(1);
    expect([...a.skipped, ...b.skipped]).toEqual([]);
    expect(stripe.adjustHold).toHaveBeenCalledOnce();
  });

  it('skips a claim whose reference a webhook stored after the read', async () => {
    h.staleAdjustmentClaims.mockResolvedValue([claim()]);
    stripe.capabilities = { shortfall: 'adjust_hold' };
    stripe.adjustHold = syncAdjust();
    // The conditional take-over finds a reference and takes nothing.
    h.reclaimStaleAdjustment.mockResolvedValueOnce(null);
    expect(await resumeStaleAdjustments(ctx)).toEqual({ resumed: 0, skipped: [] });
    expect(stripe.adjustHold).not.toHaveBeenCalled();
    expect(h.findSessionHold).not.toHaveBeenCalled();
  });

  it('asks for claims older than an hour', async () => {
    h.staleAdjustmentClaims.mockResolvedValue([claim()]);
    h.reclaimStaleAdjustment.mockResolvedValueOnce(null);
    const now = new Date('2026-10-07T12:00:00Z');
    expect(await resumeStaleAdjustments(ctx, now)).toEqual({ resumed: 0, skipped: [] });
    expect(h.staleAdjustmentClaims).toHaveBeenCalledWith(new Date('2026-10-07T11:00:00Z'));
    // The take-over uses the same age bound.
    expect(h.reclaimStaleAdjustment).toHaveBeenCalledWith(42, new Date('2026-10-07T11:00:00Z'));
  });

  it('finishes a claim whose reference was lost: Adyen replays the first answer for the key', async () => {
    const { provider, adyen } = fakeAdyenProvider(
      { authorisationAdjustment: true },
      { idempotencyReplay: true },
    );
    getPaymentProvider.mockResolvedValue(provider);
    // The settlement on session end: Adyen accepted the adjustment, the
    // reference write lost its connection, the claim stayed.
    h.results.push([SESSION]);
    h.findSessionHold.mockResolvedValue(claim({ pendingOperation: null }));
    h.markAdjustmentPending.mockResolvedValue(true);
    h.setAdjustmentRef.mockRejectedValueOnce(connectionError('ECONNRESET'));
    expect(await settleSessionPayment('s1', ctx)).toMatchObject({ status: 'adjusting' });
    expect(h.clearPendingAdjustment).not.toHaveBeenCalled();

    // The reconciliation an hour later asks again with the same key and
    // stores the reference Adyen answered the first time.
    h.staleAdjustmentClaims.mockResolvedValue([claim()]);
    h.results.push([SESSION]);
    expect(await resumeStaleAdjustments(ctx)).toEqual({ resumed: 1, skipped: [] });
    const adjustCalls = adyen.calls.filter((c) => c.path.endsWith('/amountUpdates'));
    expect(adjustCalls.map((c) => c.headers['idempotency-key'])).toEqual([
      'adjust_KHQC5N7G84BLNK43_7000',
      'adjust_KHQC5N7G84BLNK43_7000',
    ]);
    expect(h.setAdjustmentRef).toHaveBeenLastCalledWith(42, MODIFICATION_PSP);
    expect(h.markAdjustmentPending).toHaveBeenCalledOnce();
  });

  it('reports a claim without a session final cost and goes on', async () => {
    h.staleAdjustmentClaims.mockResolvedValue([claim({ id: 7 }), claim({ id: 8 })]);
    stripe.capabilities = { shortfall: 'adjust_hold' };
    stripe.adjustHold = syncAdjust();
    h.results.push([{ ...SESSION, finalCostCents: null }], [SESSION]);
    expect(await resumeStaleAdjustments(ctx)).toEqual({
      resumed: 1,
      skipped: [{ paymentRecordId: 7, reason: 'no session final cost to adjust the hold to' }],
    });
    expect(stripe.adjustHold).toHaveBeenCalledOnce();
  });

  it('is fail-open per claim', async () => {
    h.staleAdjustmentClaims.mockResolvedValue([claim({ id: 7 }), claim({ id: 8 })]);
    stripe.capabilities = { shortfall: 'adjust_hold' };
    stripe.adjustHold = syncAdjust();
    h.results.push(new Error('session read failed') as unknown as unknown[], [SESSION]);
    expect(await resumeStaleAdjustments(ctx)).toEqual({
      resumed: 1,
      skipped: [{ paymentRecordId: 7, reason: 'session read failed' }],
    });
    expect(logger.warn).toHaveBeenCalledWith(
      expect.objectContaining({ paymentRecordId: 7 }),
      'Stale adjustment resume failed',
    );
  });
});
