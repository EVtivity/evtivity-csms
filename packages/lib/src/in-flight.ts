// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

/**
 * Tracks fire-and-forget work (event handlers, pub/sub message handlers) so a
 * process can wait for it at shutdown before it closes the database and Redis
 * clients that work still uses.
 */
export interface InFlightTracker {
  /** Registers `work` until it settles. Returns the same promise. */
  track<T>(work: Promise<T>): Promise<T>;
  /** Number of tracked promises that have not settled. */
  size(): number;
  /**
   * Resolves true once no tracked work is left, including work tracked while
   * waiting (a handler that publishes another event). Resolves false when
   * work is still running after `timeoutMs`.
   */
  drain(timeoutMs: number): Promise<boolean>;
}

export function createInFlightTracker(): InFlightTracker {
  const pending = new Set<Promise<unknown>>();

  return {
    track(work) {
      pending.add(work);
      const release = (): void => {
        pending.delete(work);
      };
      work.then(release, release);
      return work;
    },

    size() {
      return pending.size;
    },

    async drain(timeoutMs) {
      const deadline = Date.now() + timeoutMs;
      while (pending.size > 0) {
        const remaining = deadline - Date.now();
        if (remaining <= 0) return false;
        let timer: NodeJS.Timeout | undefined;
        const timedOut = await Promise.race([
          Promise.allSettled([...pending]).then(() => false),
          new Promise<boolean>((resolve) => {
            timer = setTimeout(() => {
              resolve(true);
            }, remaining);
          }),
        ]);
        clearTimeout(timer);
        if (timedOut) return pending.size === 0;
      }
      return true;
    },
  };
}
