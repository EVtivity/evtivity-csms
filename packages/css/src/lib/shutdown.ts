// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import type { InFlightTracker } from '@evtivity/lib';

// How long shutdown waits for css_commands messages that are still running
// (they publish results and write css_stations) before closing the clients.
export const COMMAND_DRAIN_TIMEOUT_MS = 10_000;

export interface CssShutdownDeps {
  /** Health server, chaos timers: stop new work. */
  stopIntake: () => void;
  /** Ends the css_commands subscription. */
  unsubscribeCommands: () => Promise<void>;
  commands: InFlightTracker;
  /** Stops the simulators (closes their station sockets). */
  stopSimulators: () => Promise<void>;
  closePubSub: () => Promise<void>;
  closeDatabase: () => Promise<void>;
  exit: (code: number) => void;
  log: (message: string) => void;
}

/**
 * Returns the SIGTERM/SIGINT handler of the simulator. It runs once. Order:
 * stop intake, unsubscribe css_commands, wait for running commands (bounded),
 * stop the simulators, then close pub/sub and the database. Exit 0, or 1 on
 * an error.
 */
export function createCssShutdown(deps: CssShutdownDeps): () => Promise<void> {
  let started = false;
  return async () => {
    if (started) return;
    started = true;
    deps.log('Shutting down CSS...');
    try {
      deps.stopIntake();
      await deps.unsubscribeCommands();
      if (!(await deps.commands.drain(COMMAND_DRAIN_TIMEOUT_MS))) {
        deps.log(
          `css_commands still running after ${String(COMMAND_DRAIN_TIMEOUT_MS)} ms; closing anyway`,
        );
      }
      await deps.stopSimulators();
      await deps.closePubSub();
      await deps.closeDatabase();
      deps.exit(0);
    } catch (err: unknown) {
      deps.log(`CSS shutdown failed: ${err instanceof Error ? err.message : String(err)}`);
      deps.exit(1);
    }
  };
}
