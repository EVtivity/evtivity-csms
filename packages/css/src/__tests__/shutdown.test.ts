// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { describe, it, expect, vi } from 'vitest';
import { createInFlightTracker } from '@evtivity/lib';
import { COMMAND_DRAIN_TIMEOUT_MS, createCssShutdown } from '../lib/shutdown.js';
import type { CssShutdownDeps } from '../lib/shutdown.js';

function makeDeps(overrides: Partial<CssShutdownDeps> = {}): CssShutdownDeps & {
  order: string[];
} {
  const order: string[] = [];
  const step = (name: string) =>
    vi.fn(() => {
      order.push(name);
      return Promise.resolve();
    });
  return {
    order,
    stopIntake: vi.fn(() => {
      order.push('intake');
    }),
    unsubscribeCommands: step('unsubscribe'),
    commands: createInFlightTracker(),
    stopSimulators: step('simulators'),
    closePubSub: step('pubsub'),
    closeDatabase: step('database'),
    exit: vi.fn((code: number) => {
      order.push(`exit:${String(code)}`);
    }),
    log: vi.fn(),
    ...overrides,
  };
}

describe('createCssShutdown', () => {
  it('waits for running commands, then stops simulators and closes clients in order', async () => {
    const deps = makeDeps();
    let finishCommand: () => void = () => undefined;
    void deps.commands.track(
      new Promise<void>((resolve) => {
        finishCommand = () => {
          deps.order.push('command');
          resolve();
        };
      }),
    );
    const done = createCssShutdown(deps)();
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(deps.stopSimulators).not.toHaveBeenCalled();
    finishCommand();
    await done;

    expect(deps.order).toEqual([
      'intake',
      'unsubscribe',
      'command',
      'simulators',
      'pubsub',
      'database',
      'exit:0',
    ]);
  });

  it('runs once when SIGTERM and SIGINT both arrive', async () => {
    const deps = makeDeps();
    const shutdown = createCssShutdown(deps);
    await Promise.all([shutdown(), shutdown()]);

    expect(deps.closeDatabase).toHaveBeenCalledOnce();
    expect(deps.exit).toHaveBeenCalledOnce();
  });

  it('logs and continues when commands outlive the timeout', async () => {
    vi.useFakeTimers();
    try {
      const deps = makeDeps();
      void deps.commands.track(new Promise<void>(() => undefined));
      const done = createCssShutdown(deps)();
      await vi.advanceTimersByTimeAsync(COMMAND_DRAIN_TIMEOUT_MS);
      await done;

      expect(deps.log).toHaveBeenCalledWith(
        `css_commands still running after ${String(COMMAND_DRAIN_TIMEOUT_MS)} ms; closing anyway`,
      );
      expect(deps.exit).toHaveBeenCalledWith(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it('exits 1 when a step fails', async () => {
    const deps = makeDeps({ closePubSub: vi.fn(() => Promise.reject(new Error('redis down'))) });
    await createCssShutdown(deps)();

    expect(deps.exit).toHaveBeenCalledWith(1);
    expect(deps.closeDatabase).not.toHaveBeenCalled();
  });
});
