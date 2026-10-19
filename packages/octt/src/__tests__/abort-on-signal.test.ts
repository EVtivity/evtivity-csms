// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { EventEmitter } from 'node:events';
import { describe, it, expect, vi, afterEach } from 'vitest';
import { abortOnSignals, SIGNAL_EXIT_CODE } from '../abort-on-signal.js';

function setup(graceMs = 1_000) {
  const source = new EventEmitter();
  const controller = new AbortController();
  const exit = vi.fn();
  const logger = { warn: vi.fn(), error: vi.fn() };
  const dispose = abortOnSignals(controller, { logger, exit, graceMs, source });
  return { source, controller, exit, logger, dispose };
}

describe('abortOnSignals', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it.each(['SIGINT', 'SIGTERM'] as const)('aborts the run on %s', (signal) => {
    const { source, controller, exit } = setup();
    source.emit(signal, signal);
    expect(controller.signal.aborted).toBe(true);
    expect((controller.signal.reason as Error).message).toBe(`Received ${signal}`);
    expect(exit).not.toHaveBeenCalled();
  });

  it('exits when the cleanup takes longer than the grace time', () => {
    vi.useFakeTimers();
    const { source, exit, logger } = setup(1_000);
    source.emit('SIGTERM', 'SIGTERM');
    vi.advanceTimersByTime(999);
    expect(exit).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(exit).toHaveBeenCalledWith(SIGNAL_EXIT_CODE);
    expect(logger.error).toHaveBeenCalled();
  });

  it('exits at once on a second signal', () => {
    const { source, exit } = setup();
    source.emit('SIGINT', 'SIGINT');
    source.emit('SIGINT', 'SIGINT');
    expect(exit).toHaveBeenCalledWith(SIGNAL_EXIT_CODE);
  });

  it('removes its handlers and timer when disposed', () => {
    vi.useFakeTimers();
    const { source, controller, exit, dispose } = setup(1_000);
    source.emit('SIGINT', 'SIGINT');
    dispose();
    vi.advanceTimersByTime(5_000);
    expect(exit).not.toHaveBeenCalled();
    expect(source.listenerCount('SIGINT')).toBe(0);
    expect(source.listenerCount('SIGTERM')).toBe(0);
    expect(controller.signal.aborted).toBe(true);
  });
});
