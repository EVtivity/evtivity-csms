// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { describe, it, expect, vi, beforeEach } from 'vitest';

const m = vi.hoisted(() => {
  const inserts: Array<{ table: unknown; values: Record<string, unknown> }> = [];
  return {
    inserts,
    db: {
      insert: vi.fn((table: unknown) => ({
        values: (values: Record<string, unknown>) => {
          inserts.push({ table, values });
          return Promise.resolve();
        },
      })),
    },
    recordsWithPayments: vi.fn(),
  };
});

vi.mock('@evtivity/database', () => ({
  db: m.db,
  paymentReconciliationRuns: { __table: 'payment_reconciliation_runs' },
}));

vi.mock('../payment-records.js', () => ({ recordsWithPayments: m.recordsWithPayments }));

import { reconcilePayments, runPaymentReconciliation } from '../reconciliation.js';
import { PaymentProviderNotConfiguredError } from '../errors.js';
import type { PaymentContext } from '../context.js';
import type { PaymentProviderRegistry } from '../registry.js';
import type { PaymentStatus, ProviderPaymentState } from '../types.js';

function fakeProvider(id: string, stateLookup = true) {
  return {
    id,
    capabilities: { stateLookup },
    getPaymentState: vi.fn<(paymentId: string) => Promise<ProviderPaymentState>>(),
  };
}

const stripe = fakeProvider('stripe');
const simulated = fakeProvider('simulated', false);
const registry = { getPaymentProvider: vi.fn() };
const logger = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() };
const ctx: PaymentContext = {
  registry: registry as unknown as PaymentProviderRegistry,
  logger,
};

function state(
  providerStatus: string,
  acceptable: PaymentStatus[] | null,
  capturedCents: number | null = null,
): ProviderPaymentState {
  return {
    providerStatus,
    acceptableLocalStatuses: acceptable == null ? null : new Set(acceptable),
    capturedCents,
  };
}

function rec(id: number, overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id,
    status: 'captured',
    stripePaymentIntentId: `pi_${String(id)}`,
    stripeCustomerId: 'cus_1',
    capturedAmountCents: 1000,
    ...overrides,
  };
}

beforeEach(() => {
  m.inserts.length = 0;
  m.recordsWithPayments.mockResolvedValue([]);
  registry.getPaymentProvider.mockImplementation((id: string) =>
    Promise.resolve(id === 'stripe' ? stripe : simulated),
  );
  stripe.getPaymentState.mockResolvedValue(state('succeeded', ['captured'], 1000));
});

describe('reconcilePayments', () => {
  it('returns an empty result when no records have payments', async () => {
    const result = await reconcilePayments(ctx);

    expect(result).toEqual({ checked: 0, matched: 0, discrepancies: [], errors: [] });
    expect(m.recordsWithPayments).toHaveBeenCalledTimes(1);
    expect(m.recordsWithPayments).toHaveBeenCalledWith(expect.any(Date), 0, 200);
    expect(registry.getPaymentProvider).not.toHaveBeenCalled();
  });

  it('reads records of the lookback window', async () => {
    const before = Date.now();
    await reconcilePayments(ctx, 24);

    const since = m.recordsWithPayments.mock.calls[0]?.[0] as Date;
    expect(since.getTime()).toBeGreaterThanOrEqual(before - 24 * 3600_000);
    expect(since.getTime()).toBeLessThanOrEqual(Date.now() - 24 * 3600_000);
  });

  it('matches a record whose status and amount agree', async () => {
    m.recordsWithPayments.mockResolvedValueOnce([rec(1)]);

    const result = await reconcilePayments(ctx);

    expect(stripe.getPaymentState).toHaveBeenCalledWith('pi_1');
    expect(result).toEqual({ checked: 1, matched: 1, discrepancies: [], errors: [] });
  });

  it('reports a status the provider state does not accept', async () => {
    m.recordsWithPayments.mockResolvedValueOnce([rec(2, { status: 'pre_authorized' })]);
    stripe.getPaymentState.mockResolvedValue(
      state('succeeded', ['captured', 'partially_refunded', 'refunded'], 1000),
    );

    const result = await reconcilePayments(ctx);

    expect(result.matched).toBe(0);
    expect(result.discrepancies).toEqual([
      {
        paymentRecordId: 2,
        stripePaymentIntentId: 'pi_2',
        field: 'status',
        localValue: 'pre_authorized',
        stripeValue: 'succeeded (acceptable local: captured|partially_refunded|refunded)',
      },
    ]);
  });

  it('skips the status check for a provider status without a mapping', async () => {
    m.recordsWithPayments.mockResolvedValueOnce([rec(3, { status: 'pending' })]);
    stripe.getPaymentState.mockResolvedValue(state('unknown_status', null, null));

    const result = await reconcilePayments(ctx);

    expect(result).toMatchObject({ checked: 1, matched: 1, discrepancies: [] });
  });

  it.each(['captured', 'partially_refunded', 'refunded'] as const)(
    'reports a captured amount difference on a %s record',
    async (status) => {
      m.recordsWithPayments.mockResolvedValueOnce([rec(4, { status, capturedAmountCents: 500 })]);
      stripe.getPaymentState.mockResolvedValue(state('succeeded', [status], 800));

      const result = await reconcilePayments(ctx);

      expect(result.discrepancies).toEqual([
        {
          paymentRecordId: 4,
          stripePaymentIntentId: 'pi_4',
          field: 'capturedAmountCents',
          localValue: '500',
          stripeValue: '800',
        },
      ]);
      expect(result.matched).toBe(0);
    },
  );

  it('does not compare amounts of a record that is not captured', async () => {
    m.recordsWithPayments.mockResolvedValueOnce([
      rec(5, { status: 'pre_authorized', capturedAmountCents: 500 }),
    ]);
    stripe.getPaymentState.mockResolvedValue(state('requires_capture', ['pre_authorized'], 0));

    const result = await reconcilePayments(ctx);

    expect(result).toMatchObject({ checked: 1, matched: 1, discrepancies: [] });
  });

  it('does not compare amounts when either side is unknown', async () => {
    m.recordsWithPayments.mockResolvedValueOnce([
      rec(6, { capturedAmountCents: null }),
      rec(7, { capturedAmountCents: 500 }),
    ]);
    stripe.getPaymentState
      .mockResolvedValueOnce(state('succeeded', ['captured'], 800))
      .mockResolvedValueOnce(state('succeeded', ['captured'], null));

    const result = await reconcilePayments(ctx);

    expect(result).toMatchObject({ checked: 2, matched: 2, discrepancies: [] });
  });

  it('records a failed lookup as an error, not a discrepancy', async () => {
    m.recordsWithPayments.mockResolvedValueOnce([rec(8), rec(9)]);
    stripe.getPaymentState
      .mockRejectedValueOnce(new Error('rate limited'))
      .mockResolvedValueOnce(state('succeeded', ['captured'], 1000));

    const result = await reconcilePayments(ctx);

    expect(result).toEqual({
      checked: 2,
      matched: 1,
      discrepancies: [],
      errors: ['Failed to retrieve pi_8: rate limited'],
    });
    expect(logger.warn).toHaveBeenCalledWith(
      { paymentId: 'pi_8', error: 'rate limited' },
      'Failed to read the payment during reconciliation',
    );
  });

  it('uses a fallback message for a non-Error lookup failure', async () => {
    m.recordsWithPayments.mockResolvedValueOnce([rec(10)]);
    stripe.getPaymentState.mockRejectedValueOnce('weird');

    const result = await reconcilePayments(ctx);

    expect(result.errors).toEqual(['Failed to retrieve pi_10: Unknown error']);
  });

  it('adds one error for a provider that is not configured and skips its records', async () => {
    registry.getPaymentProvider.mockRejectedValue(new PaymentProviderNotConfiguredError('stripe'));
    m.recordsWithPayments.mockResolvedValueOnce([rec(11), rec(12), rec(13)]);

    const result = await reconcilePayments(ctx);

    expect(registry.getPaymentProvider).toHaveBeenCalledTimes(1);
    expect(result).toEqual({
      checked: 0,
      matched: 0,
      discrepancies: [],
      errors: ['Payment provider stripe not configured'],
    });
    expect(logger.warn).toHaveBeenCalledWith(
      { provider: 'stripe' },
      'Payment reconciliation skipped: provider not configured',
    );
  });

  it('rethrows an unexpected provider lookup error', async () => {
    registry.getPaymentProvider.mockRejectedValue(new Error('settings unreadable'));
    m.recordsWithPayments.mockResolvedValueOnce([rec(14)]);

    await expect(reconcilePayments(ctx)).rejects.toThrow('settings unreadable');
  });

  it('skips records of providers without a status lookup', async () => {
    m.recordsWithPayments.mockResolvedValueOnce([
      rec(15, { stripeCustomerId: 'cus_sim_1', stripePaymentIntentId: 'pi_sim_15' }),
      rec(16),
    ]);

    const result = await reconcilePayments(ctx);

    expect(registry.getPaymentProvider).toHaveBeenCalledWith('simulated');
    expect(stripe.getPaymentState).toHaveBeenCalledTimes(1);
    expect(stripe.getPaymentState).toHaveBeenCalledWith('pi_16');
    expect(result).toMatchObject({ checked: 1, matched: 1 });
  });

  it('skips a provider that declares a state lookup but has no getPaymentState', async () => {
    registry.getPaymentProvider.mockResolvedValue({
      id: 'stripe',
      capabilities: { stateLookup: true },
    });
    m.recordsWithPayments.mockResolvedValueOnce([rec(17)]);

    const result = await reconcilePayments(ctx);

    expect(result).toMatchObject({ checked: 0, matched: 0 });
  });

  it('pages through full batches after the last id and stops on a short batch', async () => {
    const full = Array.from({ length: 200 }, (_, i) => rec(i + 1));
    m.recordsWithPayments.mockResolvedValueOnce(full).mockResolvedValueOnce([rec(201)]);

    const result = await reconcilePayments(ctx);

    expect(m.recordsWithPayments).toHaveBeenCalledTimes(2);
    expect(m.recordsWithPayments.mock.calls[1]?.[1]).toBe(200);
    expect(result).toMatchObject({ checked: 201, matched: 201 });
    expect(registry.getPaymentProvider).toHaveBeenCalledTimes(1);
  });

  it('stops on an empty batch after a full one', async () => {
    const full = Array.from({ length: 200 }, (_, i) => rec(i + 1));
    m.recordsWithPayments.mockResolvedValueOnce(full).mockResolvedValueOnce([]);

    const result = await reconcilePayments(ctx);

    expect(m.recordsWithPayments).toHaveBeenCalledTimes(2);
    expect(result.checked).toBe(200);
    expect(logger.info).toHaveBeenCalledWith(
      { checked: 200, matched: 200, discrepancies: 0, errors: 0 },
      'Payment reconciliation completed',
    );
  });
});

describe('runPaymentReconciliation', () => {
  it('stores a clean run with errors as null', async () => {
    m.recordsWithPayments.mockResolvedValueOnce([rec(1)]);

    const result = await runPaymentReconciliation(ctx);

    expect(result).toMatchObject({ checked: 1, matched: 1 });
    expect(m.inserts).toEqual([
      {
        table: { __table: 'payment_reconciliation_runs' },
        values: {
          checkedCount: 1,
          matchedCount: 1,
          discrepancyCount: 0,
          errorCount: 0,
          discrepancies: [],
          errors: null,
        },
      },
    ]);
  });

  it('stores discrepancies and errors', async () => {
    m.recordsWithPayments.mockResolvedValueOnce([rec(1, { status: 'pre_authorized' }), rec(2)]);
    stripe.getPaymentState
      .mockResolvedValueOnce(state('succeeded', ['captured'], 1000))
      .mockRejectedValueOnce(new Error('timeout'));

    await runPaymentReconciliation(ctx);

    expect(m.inserts[0]?.values).toMatchObject({
      checkedCount: 2,
      matchedCount: 0,
      discrepancyCount: 1,
      errorCount: 1,
      discrepancies: [expect.objectContaining({ paymentRecordId: 1, field: 'status' })],
      errors: ['Failed to retrieve pi_2: timeout'],
    });
  });
});
