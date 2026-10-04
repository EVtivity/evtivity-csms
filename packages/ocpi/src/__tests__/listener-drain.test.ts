// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { describe, it, expect, vi } from 'vitest';
import { createInFlightTracker, createLogger } from '@evtivity/lib';

const initiateRegistration = vi.fn();
vi.mock('../services/credentials.service.js', () => ({
  initiateRegistration: (...args: unknown[]) => initiateRegistration(...args) as Promise<void>,
}));

import {
  LISTENER_DRAIN_TIMEOUT_MS,
  drainListener,
  trackListenerWork,
} from '../lib/listener-drain.js';
import { OcpiRegisterListener } from '../services/register-listener.service.js';

describe('listener drain', () => {
  it('logs a failed message handler at error level instead of rejecting', async () => {
    const tracker = createInFlightTracker();
    const logger = createLogger('test');
    const error = vi.spyOn(logger, 'error').mockImplementation(() => undefined);

    trackListenerWork(tracker, logger, () => Promise.reject(new Error('push failed')));

    await expect(tracker.drain(1000)).resolves.toBe(true);
    expect(error).toHaveBeenCalledWith(
      { err: expect.any(Error) as Error },
      'Listener message handling failed',
    );
  });

  it('warns when work is still running at the timeout', async () => {
    vi.useFakeTimers();
    try {
      const tracker = createInFlightTracker();
      const logger = createLogger('test');
      const warn = vi.spyOn(logger, 'warn').mockImplementation(() => undefined);
      trackListenerWork(tracker, logger, () => new Promise<void>(() => undefined));

      const draining = drainListener(tracker, logger);
      await vi.advanceTimersByTimeAsync(LISTENER_DRAIN_TIMEOUT_MS);
      await draining;

      expect(warn).toHaveBeenCalledWith(
        { timeoutMs: LISTENER_DRAIN_TIMEOUT_MS, inFlight: 1 },
        'Listener work still running at shutdown; closing anyway',
      );
    } finally {
      vi.useRealTimers();
    }
  });

  it('stop() of a listener waits for the message it is handling', async () => {
    let deliver: (payload: string) => void = () => undefined;
    const unsubscribe = vi.fn().mockResolvedValue(undefined);
    const pubsub = {
      publish: vi.fn(),
      subscribe: vi.fn((_channel: string, handler: (payload: string) => void) => {
        deliver = handler;
        return Promise.resolve({ unsubscribe });
      }),
      close: vi.fn(),
    };
    let finishRegistration: () => void = () => undefined;
    initiateRegistration.mockReturnValue(
      new Promise<void>((resolve) => {
        finishRegistration = resolve;
      }),
    );
    const order: string[] = [];

    const listener = new OcpiRegisterListener(pubsub);
    await listener.start();
    deliver(JSON.stringify({ partnerId: 'partner-1' }));
    const stopping = listener.stop().then(() => {
      order.push('stopped');
    });
    await new Promise((resolve) => setTimeout(resolve, 10));
    order.push('registration-done');
    finishRegistration();
    await stopping;

    expect(unsubscribe).toHaveBeenCalledOnce();
    expect(order).toEqual(['registration-done', 'stopped']);
  });
});
