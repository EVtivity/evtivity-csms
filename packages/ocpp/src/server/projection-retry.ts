// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { pgConnectionErrorKind } from '@evtivity/database';

/**
 * One run of a projection. A retried projection runs its handler again from
 * the start, so a step that must not run twice goes through `once` or `memo`.
 */
export interface ProjectionAttempt {
  /** 1 for the first run, 2 for the first retry. */
  readonly number: number;
  /**
   * True on the last run the options allow (always with retries disabled). A
   * fail-open step that rethrows a connection error so the retry sees it
   * warns and continues instead on the last run, so the steps after it still
   * run.
   */
  readonly isLast: boolean;
  /**
   * Runs a step that is not idempotent (an INSERT of a log row) once per event:
   * after it succeeded, a retry gets its first result without running it. The
   * step must be one statement, or idempotent up to its last statement. When
   * any statement of the step fails because the connection was lost while it
   * ran (`interrupted`), reads included, the step may have committed, so the
   * projection is not retried. A `once` step therefore holds the effect only:
   * reads and idempotent statements go before it, outside the step.
   */
  once<T>(key: string, step: () => Promise<T>): Promise<T>;
  /**
   * Runs an idempotent step whose first result must survive a retry (a status
   * write that returns the previous status): after it succeeded, a retry gets
   * that result. A failed step may run again, whatever the failure.
   */
  memo<T>(key: string, step: () => Promise<T>): Promise<T>;
}

export interface ProjectionRetryOptions {
  /** Runs in total, the first included. 1 disables retries. */
  maxAttempts: number;
  /** Backoff before the first retry; doubles per retry, capped at maxDelayMs. */
  baseDelayMs: number;
  maxDelayMs: number;
  /** Jitter source in [0, 1). */
  random?: () => number;
  /** Called before each retry's backoff. */
  onRetry?: (info: { attempt: number; delayMs: number; err: unknown }) => void;
}

/**
 * Three runs over about 1.5 seconds of backoff (0.25-0.5s, then 0.5-1s). A
 * connection timeout itself already takes the pool's connect timeout, so the
 * projection lane holds the station's (or transaction's) later events for that
 * long at most, then goes on.
 */
export const PROJECTION_RETRY_DEFAULTS: ProjectionRetryOptions = {
  maxAttempts: 3,
  baseDelayMs: 500,
  maxDelayMs: 4000,
};

/**
 * Backoff before retry `retry` (1 for the first retry): equal jitter, half the
 * exponential delay plus a random share of the other half, so stations that
 * failed together in a reconnect storm do not retry together.
 */
export function projectionRetryDelayMs(
  retry: number,
  options: Pick<ProjectionRetryOptions, 'baseDelayMs' | 'maxDelayMs'>,
  random: () => number = Math.random,
): number {
  const exponential = Math.min(options.maxDelayMs, options.baseDelayMs * 2 ** (retry - 1));
  return Math.round(exponential / 2 + random() * (exponential / 2));
}

/**
 * Runs a projection, and runs it again after a backoff when it failed because
 * the database connection was lost (`pgConnectionErrorKind`). Any other error,
 * the last attempt's error, and a connection lost inside a `once` step are
 * thrown to the caller. Retries run inside the caller's queued work, so the
 * projection lane does not move on until the event is projected or given up.
 */
export async function runProjectionWithRetry(
  work: (attempt: ProjectionAttempt) => Promise<void>,
  options: ProjectionRetryOptions,
): Promise<void> {
  const results = new Map<string, unknown>();
  // Set when a `once` step lost its connection mid-statement: it may have
  // committed, so running the projection again could repeat it.
  const state = { mayHaveCommitted: false };
  const random = options.random ?? Math.random;

  async function remember<T>(key: string, step: () => Promise<T>, once: boolean): Promise<T> {
    if (results.has(key)) return results.get(key) as T;
    try {
      const value = await step();
      results.set(key, value);
      return value;
    } catch (err) {
      if (once && pgConnectionErrorKind(err) === 'interrupted') state.mayHaveCommitted = true;
      throw err;
    }
  }

  for (let number = 1; ; number++) {
    const attempt: ProjectionAttempt = {
      number,
      isLast: number >= options.maxAttempts,
      once: (key, step) => remember(key, step, true),
      memo: (key, step) => remember(key, step, false),
    };
    try {
      await work(attempt);
      return;
    } catch (err) {
      if (
        number >= options.maxAttempts ||
        state.mayHaveCommitted ||
        pgConnectionErrorKind(err) == null
      ) {
        throw err;
      }
      const delayMs = projectionRetryDelayMs(number, options, random);
      options.onRetry?.({ attempt: number, delayMs, err });
      await new Promise<void>((resolve) => {
        setTimeout(resolve, delayMs);
      });
    }
  }
}
