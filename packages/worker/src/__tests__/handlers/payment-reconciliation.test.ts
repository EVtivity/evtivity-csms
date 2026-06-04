// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { Logger } from 'pino';

// db.insert(...).values(...) is the only db usage. Capture the inserted row.
const mockValues = vi.fn().mockResolvedValue(undefined);
const mockInsert = vi.fn(() => ({ values: mockValues }));

vi.mock('@evtivity/database', () => ({
  db: { insert: mockInsert },
  paymentReconciliationRuns: { __table: 'payment_reconciliation_runs' },
}));

const mockReconcile = vi.fn();
vi.mock('@evtivity/api/src/services/payment-reconciliation.service.js', () => ({
  reconcilePayments: (...args: unknown[]) => mockReconcile(...args),
}));

function makeLog(): Logger {
  return {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  } as unknown as Logger;
}

describe('paymentReconciliationHandler', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockValues.mockResolvedValue(undefined);
  });

  it('stores a clean run and logs completion when there are no discrepancies', async () => {
    mockReconcile.mockResolvedValue({
      checked: 12,
      matched: 12,
      discrepancies: [],
      errors: [],
    });
    const log = makeLog();
    const { paymentReconciliationHandler } =
      await import('../../handlers/payment-reconciliation.js');

    await paymentReconciliationHandler(log);

    expect(mockReconcile).toHaveBeenCalledWith(log);
    expect(mockInsert).toHaveBeenCalledWith(
      expect.objectContaining({ __table: 'payment_reconciliation_runs' }),
    );
    expect(mockValues).toHaveBeenCalledWith({
      checkedCount: 12,
      matchedCount: 12,
      discrepancyCount: 0,
      errorCount: 0,
      discrepancies: [],
      errors: null, // no errors -> null, not []
    });
    expect(log.info).toHaveBeenCalledWith(
      { checked: 12, matched: 12 },
      'Payment reconciliation completed',
    );
    expect(log.warn).not.toHaveBeenCalled();
  });

  it('stores discrepancy and error counts and warns when discrepancies are found', async () => {
    const discrepancies = [
      {
        paymentRecordId: 1,
        stripePaymentIntentId: 'pi_1',
        field: 'status',
        localValue: 'pre_authorized',
        stripeValue: 'captured',
      },
      {
        paymentRecordId: 2,
        stripePaymentIntentId: 'pi_2',
        field: 'capturedAmount',
        localValue: '500',
        stripeValue: '800',
      },
    ];
    mockReconcile.mockResolvedValue({
      checked: 5,
      matched: 3,
      discrepancies,
      errors: ['Stripe rate limited'],
    });
    const log = makeLog();
    const { paymentReconciliationHandler } =
      await import('../../handlers/payment-reconciliation.js');

    await paymentReconciliationHandler(log);

    expect(mockValues).toHaveBeenCalledWith({
      checkedCount: 5,
      matchedCount: 3,
      discrepancyCount: 2,
      errorCount: 1,
      discrepancies,
      errors: ['Stripe rate limited'], // errors present -> stored as-is
    });
    expect(log.warn).toHaveBeenCalledWith(
      { discrepancies: 2, checked: 5 },
      'Payment reconciliation found discrepancies',
    );
    expect(log.info).not.toHaveBeenCalled();
  });

  it('stores errors as null when the error list is empty even if other counts are non-zero', async () => {
    mockReconcile.mockResolvedValue({
      checked: 4,
      matched: 4,
      discrepancies: [],
      errors: [],
    });
    const { paymentReconciliationHandler } =
      await import('../../handlers/payment-reconciliation.js');

    await paymentReconciliationHandler(makeLog());

    expect(mockValues).toHaveBeenCalledWith(expect.objectContaining({ errors: null }));
  });

  it('propagates an error if reconcilePayments throws (fail-loud for the cron framework)', async () => {
    mockReconcile.mockRejectedValue(new Error('Stripe not configured'));
    const { paymentReconciliationHandler } =
      await import('../../handlers/payment-reconciliation.js');

    await expect(paymentReconciliationHandler(makeLog())).rejects.toThrow('Stripe not configured');
    expect(mockInsert).not.toHaveBeenCalled();
  });
});
