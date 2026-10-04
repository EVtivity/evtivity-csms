// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { describe, it, expect, vi } from 'vitest';
import { APP_CLOSE_TIMEOUT_MS, createShutdownHandler } from '../lib/process-shutdown.js';
import type { ShutdownDeps } from '../lib/process-shutdown.js';

function makeDeps(overrides: Partial<ShutdownDeps> = {}): ShutdownDeps & { order: string[] } {
  const order: string[] = [];
  return {
    order,
    closeApp: vi.fn(() => {
      order.push('app');
      return Promise.resolve();
    }),
    closeDatabase: vi.fn(() => {
      order.push('database');
      return Promise.resolve();
    }),
    exit: vi.fn((code: number) => {
      order.push(`exit:${String(code)}`);
    }),
    logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
    ...overrides,
  };
}

describe('createShutdownHandler', () => {
  it('closes the app, then the database, then exits 0', async () => {
    const deps = makeDeps();
    await createShutdownHandler(deps)('SIGTERM');

    expect(deps.order).toEqual(['app', 'database', 'exit:0']);
    expect(deps.logger.info).toHaveBeenCalledWith(
      { signal: 'SIGTERM' },
      'API graceful shutdown complete',
    );
  });

  it('runs once when SIGTERM and SIGINT both arrive', async () => {
    let finishApp: () => void = () => undefined;
    const deps = makeDeps({
      closeApp: vi.fn(
        () =>
          new Promise<void>((resolve) => {
            finishApp = resolve;
          }),
      ),
    });
    const shutdown = createShutdownHandler(deps);

    const first = shutdown('SIGTERM');
    await shutdown('SIGINT');
    finishApp();
    await first;

    expect(deps.closeApp).toHaveBeenCalledOnce();
    expect(deps.closeDatabase).toHaveBeenCalledOnce();
    expect(deps.exit).toHaveBeenCalledOnce();
  });

  it('does not close the database until the app has closed', async () => {
    let finishApp: () => void = () => undefined;
    const deps = makeDeps({
      closeApp: vi.fn(
        () =>
          new Promise<void>((resolve) => {
            finishApp = resolve;
          }),
      ),
    });
    const done = createShutdownHandler(deps)('SIGTERM');
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(deps.closeDatabase).not.toHaveBeenCalled();

    finishApp();
    await done;
    expect(deps.closeDatabase).toHaveBeenCalledOnce();
  });

  it('warns and continues when in-flight requests outlive the timeout', async () => {
    vi.useFakeTimers();
    try {
      const deps = makeDeps({ closeApp: vi.fn(() => new Promise<void>(() => undefined)) });
      const done = createShutdownHandler(deps)('SIGTERM');
      await vi.advanceTimersByTimeAsync(APP_CLOSE_TIMEOUT_MS);
      await done;

      expect(deps.logger.warn).toHaveBeenCalledWith(
        { timeoutMs: APP_CLOSE_TIMEOUT_MS },
        'In-flight requests still running at shutdown; closing anyway',
      );
      expect(deps.order).toEqual(['database', 'exit:0']);
    } finally {
      vi.useRealTimers();
    }
  });

  it('exits 1 when closing fails', async () => {
    const deps = makeDeps({
      closeDatabase: vi.fn(() => Promise.reject(new Error('end failed'))),
    });
    await createShutdownHandler(deps)('SIGTERM');

    expect(deps.exit).toHaveBeenCalledWith(1);
    expect(deps.logger.error).toHaveBeenCalled();
  });

  it('keeps the shutdown inside a 30 s stop timeout', () => {
    // 5 s database close timeout (client.end) on top of the app close bound.
    expect(APP_CLOSE_TIMEOUT_MS + 5000).toBeLessThan(30_000);
  });
});
