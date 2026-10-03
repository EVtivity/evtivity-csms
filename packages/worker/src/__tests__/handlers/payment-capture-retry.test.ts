// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { describe, it, expect, vi } from 'vitest';
import type { Logger } from 'pino';

const { mockRetryShortfalls, mockPaymentContext, ctx } = vi.hoisted(() => {
  const paymentCtx = { registry: 'registry', logger: 'logger' };
  return {
    mockRetryShortfalls: vi.fn(),
    mockPaymentContext: vi.fn((_log: unknown) => paymentCtx),
    ctx: paymentCtx,
  };
});

vi.mock('@evtivity/payments', () => ({
  retryShortfalls: mockRetryShortfalls,
}));

vi.mock('../../lib/payments.js', () => ({
  paymentContext: mockPaymentContext,
}));

import { paymentCaptureRetryHandler } from '../../handlers/payment-capture-retry.js';

function makeLog(): Logger {
  return {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  } as unknown as Logger;
}

describe('paymentCaptureRetryHandler', () => {
  it('retries shortfalls through the worker payment context', async () => {
    mockRetryShortfalls.mockResolvedValue({ total: 0, recovered: 0, stillFailed: 0 });
    const log = makeLog();

    await paymentCaptureRetryHandler(log);

    expect(mockPaymentContext).toHaveBeenCalledWith(log);
    expect(mockRetryShortfalls).toHaveBeenCalledWith(ctx);
  });

  it('logs at debug and no summary when no shortfall rows are found', async () => {
    mockRetryShortfalls.mockResolvedValue({ total: 0, recovered: 0, stillFailed: 0 });
    const log = makeLog();

    await paymentCaptureRetryHandler(log);

    expect(log.debug).toHaveBeenCalledWith('No payment records with capture shortfall to retry');
    expect(log.info).not.toHaveBeenCalled();
  });

  it('logs the pass summary with recovered and still-failed counts', async () => {
    mockRetryShortfalls.mockResolvedValue({ total: 2, recovered: 1, stillFailed: 1 });
    const log = makeLog();

    await paymentCaptureRetryHandler(log);

    expect(log.info).toHaveBeenCalledWith(
      { recovered: 1, stillFailed: 1, total: 2 },
      'Capture retry pass complete',
    );
    expect(log.debug).not.toHaveBeenCalled();
  });

  it('propagates an error from the retry pass (fail-loud for the cron framework)', async () => {
    mockRetryShortfalls.mockRejectedValue(new Error('unable to authenticate data'));

    await expect(paymentCaptureRetryHandler(makeLog())).rejects.toThrow(
      'unable to authenticate data',
    );
  });
});
