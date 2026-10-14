// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { pgConnectionErrorKind, pgErrorCode } from './pg-errors.js';

export interface PgConnectionRejectionLogger {
  warn(obj: Record<string, unknown>, msg: string): void;
}

interface ProcessLike {
  on(event: 'unhandledRejection', listener: (reason: unknown) => void): unknown;
  off(event: 'unhandledRejection', listener: (reason: unknown) => void): unknown;
  listenerCount(event: 'unhandledRejection'): number;
}

/**
 * Keeps the process serving when postgres.js rejects a promise nothing awaits
 * because its connection was lost.
 *
 * postgres.js 3.4.9 fetches the array types on every new connection
 * (`fetch_types`) in a promise it never handles. When the backend is
 * terminated during that fetch (`pg_terminate_backend`, a failover, a restart:
 * 57P01), the waiting query fails with the error, and the fetch's rejection
 * also escapes as an unhandled rejection, which ends a Node process
 * (porsager/postgres#1223, unfixed upstream). The pool reconnects on its own,
 * so the only harm is the exit.
 *
 * The listener logs a rejection classified as a lost database connection
 * (`pgConnectionErrorKind`) at warn and lets the process go on. Every other
 * unhandled rejection is thrown again, which ends the process as Node does by
 * default, unless another listener (Sentry) already handles them.
 *
 * Returns a function that removes the listener.
 */
export function guardPgConnectionRejections(
  logger: PgConnectionRejectionLogger,
  target: ProcessLike = process,
): () => void {
  const listener = (reason: unknown): void => {
    if (pgConnectionErrorKind(reason) != null) {
      logger.warn(
        {
          errorCode: pgErrorCode(reason),
          error: reason instanceof Error ? reason.message : String(reason),
        },
        'Database connection lost under a promise nothing awaits; the pool reconnects',
      );
      return;
    }
    if (target.listenerCount('unhandledRejection') > 1) return;
    throw reason;
  };
  target.on('unhandledRejection', listener);
  return () => {
    target.off('unhandledRejection', listener);
  };
}
