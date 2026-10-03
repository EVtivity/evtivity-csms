// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { describe, it, expect, vi } from 'vitest';
import type { Logger } from 'pino';

const { mockRunPaymentReconciliation, mockPaymentContext, ctx } = vi.hoisted(() => {
  const paymentCtx = { registry: 'registry', logger: 'logger' };
  return {
    mockRunPaymentReconciliation: vi.fn(),
    mockPaymentContext: vi.fn((_log: unknown) => paymentCtx),
    ctx: paymentCtx,
  };
});

vi.mock('@evtivity/payments', () => ({
  runPaymentReconciliation: mockRunPaymentReconciliation,
}));

vi.mock('../../lib/payments.js', () => ({
  paymentContext: mockPaymentContext,
}));

import { paymentReconciliationHandler } from '../../handlers/payment-reconciliation.js';

function makeLog(): Logger {
  return {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  } as unknown as Logger;
}

describe('paymentReconciliationHandler', () => {
  it('runs reconciliation with the worker payment context and logs completion', async () => {
    mockRunPaymentReconciliation.mockResolvedValue({
      checked: 12,
      matched: 12,
      discrepancies: [],
      errors: [],
    });
    const log = makeLog();

    await paymentReconciliationHandler(log);

    expect(mockPaymentContext).toHaveBeenCalledWith(log);
    expect(mockRunPaymentReconciliation).toHaveBeenCalledWith(ctx);
    expect(log.info).toHaveBeenCalledWith(
      { checked: 12, matched: 12 },
      'Payment reconciliation completed',
    );
    expect(log.warn).not.toHaveBeenCalled();
  });

  it('warns when discrepancies are found', async () => {
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
        field: 'capturedAmountCents',
        localValue: '500',
        stripeValue: '800',
      },
    ];
    mockRunPaymentReconciliation.mockResolvedValue({
      checked: 5,
      matched: 3,
      discrepancies,
      errors: ['Stripe rate limited'],
    });
    const log = makeLog();

    await paymentReconciliationHandler(log);

    expect(log.warn).toHaveBeenCalledWith(
      { discrepancies: 2, checked: 5 },
      'Payment reconciliation found discrepancies',
    );
    expect(log.info).not.toHaveBeenCalled();
  });

  it('propagates an error from the run (fail-loud for the cron framework)', async () => {
    mockRunPaymentReconciliation.mockRejectedValue(new Error('db down'));

    await expect(paymentReconciliationHandler(makeLog())).rejects.toThrow('db down');
  });
});
