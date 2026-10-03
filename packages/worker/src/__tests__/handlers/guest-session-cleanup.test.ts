// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { describe, it, expect, vi } from 'vitest';
import type { Logger } from 'pino';

const { mockExpireGuestSessions, mockPaymentContext, ctx } = vi.hoisted(() => {
  const paymentCtx = { registry: 'registry', logger: 'logger' };
  return {
    mockExpireGuestSessions: vi.fn(),
    mockPaymentContext: vi.fn((_log: unknown) => paymentCtx),
    ctx: paymentCtx,
  };
});

vi.mock('@evtivity/payments', () => ({
  expireGuestSessions: mockExpireGuestSessions,
}));

vi.mock('../../lib/payments.js', () => ({
  paymentContext: mockPaymentContext,
}));

import { guestSessionCleanupHandler } from '../../handlers/guest-session-cleanup.js';

function makeLog(): Logger {
  return { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } as unknown as Logger;
}

describe('guestSessionCleanupHandler', () => {
  it('expires guest sessions through the worker payment context', async () => {
    mockExpireGuestSessions.mockResolvedValue(0);
    const log = makeLog();
    await guestSessionCleanupHandler(log);

    expect(mockPaymentContext).toHaveBeenCalledWith(log);
    expect(mockExpireGuestSessions).toHaveBeenCalledWith(ctx);
  });

  it('logs no summary when no sessions are expired', async () => {
    mockExpireGuestSessions.mockResolvedValue(0);
    const log = makeLog();
    await guestSessionCleanupHandler(log);

    expect(log.info).not.toHaveBeenCalled();
  });

  it('logs the number of expired sessions', async () => {
    mockExpireGuestSessions.mockResolvedValue(3);
    const log = makeLog();
    await guestSessionCleanupHandler(log);

    expect(log.info).toHaveBeenCalledWith({ count: 3 }, 'Expired guest sessions cleaned up');
  });

  it('propagates an error from the expiry pass (fail-loud for the cron framework)', async () => {
    mockExpireGuestSessions.mockRejectedValue(new Error('db down'));
    await expect(guestSessionCleanupHandler(makeLog())).rejects.toThrow('db down');
  });
});
