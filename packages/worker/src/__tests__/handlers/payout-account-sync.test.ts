// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { describe, it, expect, vi } from 'vitest';
import type { Logger } from 'pino';

const { mockRefreshAll, mockPaymentContext, ctx } = vi.hoisted(() => {
  const paymentCtx = { registry: 'registry', logger: 'logger' };
  return {
    mockRefreshAll: vi.fn(),
    mockPaymentContext: vi.fn((_log: unknown) => paymentCtx),
    ctx: paymentCtx,
  };
});

vi.mock('@evtivity/payments', () => ({ refreshAllPayoutAccounts: mockRefreshAll }));
vi.mock('../../lib/payments.js', () => ({ paymentContext: mockPaymentContext }));

import { payoutAccountSyncHandler } from '../../handlers/payout-account-sync.js';

function makeLog(): Logger {
  return { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() } as unknown as Logger;
}

describe('payoutAccountSyncHandler', () => {
  it('refreshes every payout account through the worker payment context', async () => {
    mockRefreshAll.mockResolvedValue({ total: 3, refreshed: 2, failed: 1 });
    const log = makeLog();

    await payoutAccountSyncHandler(log);

    expect(mockPaymentContext).toHaveBeenCalledWith(log);
    expect(mockRefreshAll).toHaveBeenCalledWith(ctx);
    expect(log.info).toHaveBeenCalledWith(
      { total: 3, refreshed: 2, failed: 1 },
      'Payout account sync complete',
    );
  });

  it('logs at debug when no site has a payout account', async () => {
    mockRefreshAll.mockResolvedValue({ total: 0, refreshed: 0, failed: 0 });
    const log = makeLog();

    await payoutAccountSyncHandler(log);

    expect(log.debug).toHaveBeenCalledWith('No payout accounts to sync');
    expect(log.info).not.toHaveBeenCalled();
  });

  it('propagates a failure to list the accounts, so the cron run is marked failed', async () => {
    mockRefreshAll.mockRejectedValue(new Error('db down'));
    await expect(payoutAccountSyncHandler(makeLog())).rejects.toThrow('db down');
  });
});
