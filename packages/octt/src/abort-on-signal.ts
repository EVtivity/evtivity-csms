// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import type pino from 'pino';

/** How long the CLI gives an interrupted run to restore its settings and delete its data. */
export const CLI_ABORT_GRACE_MS = 120_000;

/** Exit code of a process stopped by a signal it handled (128 + SIGINT). */
export const SIGNAL_EXIT_CODE = 130;

export interface SignalSource {
  on(event: NodeJS.Signals, listener: (signal: NodeJS.Signals) => void): unknown;
  off(event: NodeJS.Signals, listener: (signal: NodeJS.Signals) => void): unknown;
}

export interface AbortOnSignalsOptions {
  logger: Pick<pino.Logger, 'warn' | 'error'>;
  exit: (code: number) => void;
  graceMs?: number;
  source?: SignalSource;
}

/**
 * Aborts the run on SIGINT or SIGTERM so it restores its settings and deletes
 * its data, and exits when that takes longer than the grace time (the next
 * run or the worker sweep then restores the settings). A second signal exits
 * at once. Returns a function that removes the handlers.
 */
export function abortOnSignals(
  controller: AbortController,
  { logger, exit, graceMs = CLI_ABORT_GRACE_MS, source = process }: AbortOnSignalsOptions,
): () => void {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const onSignal = (signal: NodeJS.Signals): void => {
    if (controller.signal.aborted) {
      logger.error({ signal }, 'Second signal, exiting without finishing the cleanup');
      exit(SIGNAL_EXIT_CODE);
      return;
    }
    logger.warn({ signal, graceMs }, 'Stopping the run: restoring settings and deleting test data');
    controller.abort(new Error(`Received ${signal}`));
    timer = setTimeout(() => {
      logger.error(
        { graceMs },
        'Cleanup did not finish in time; the next run or the worker sweep restores the settings',
      );
      exit(SIGNAL_EXIT_CODE);
    }, graceMs);
    timer.unref();
  };
  source.on('SIGINT', onSignal);
  source.on('SIGTERM', onSignal);
  return () => {
    clearTimeout(timer);
    source.off('SIGINT', onSignal);
    source.off('SIGTERM', onSignal);
  };
}
