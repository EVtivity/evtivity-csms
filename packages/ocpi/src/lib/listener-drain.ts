// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import type { InFlightTracker, Logger } from '@evtivity/lib';

// How long a pub/sub listener's stop() waits for the messages it is still
// handling (partner pushes, pulls, callbacks). The listeners stop in parallel,
// and the process closes pub/sub and Redis only after they return, so this
// stays inside the 30 s ECS stop timeout and the Kubernetes grace period.
export const LISTENER_DRAIN_TIMEOUT_MS = 10_000;

/**
 * Runs `work` for one pub/sub message under `tracker`, logging a failure at
 * error level so the rejection is never lost.
 */
export function trackListenerWork(
  tracker: InFlightTracker,
  logger: Logger,
  work: () => Promise<void>,
): void {
  void tracker.track(
    work().catch((err: unknown) => {
      logger.error({ err }, 'Listener message handling failed');
    }),
  );
}

/** Waits for the tracked work; logs at warn when the timeout is reached. */
export async function drainListener(tracker: InFlightTracker, logger: Logger): Promise<void> {
  const drained = await tracker.drain(LISTENER_DRAIN_TIMEOUT_MS);
  if (!drained) {
    logger.warn(
      { timeoutMs: LISTENER_DRAIN_TIMEOUT_MS, inFlight: tracker.size() },
      'Listener work still running at shutdown; closing anyway',
    );
  }
}
