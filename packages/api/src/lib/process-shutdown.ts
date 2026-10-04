// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

// Bound for `app.close()`: in-flight requests finish, SSE streams end
// (preClose), then the onClose hooks run (pub/sub, Redis, metrics server).
// Plus the database close this stays inside the 30 s ECS stop timeout and the
// default Kubernetes termination grace period (30 s).
export const APP_CLOSE_TIMEOUT_MS = 20_000;

interface ShutdownLogger {
  info(obj: object, msg: string): void;
  warn(obj: object, msg: string): void;
  error(obj: object, msg: string): void;
}

export interface ShutdownDeps {
  /** Fastify `app.close()`. */
  closeApp: () => Promise<void>;
  /** Ends the process-wide database client; runs after the app is closed. */
  closeDatabase: () => Promise<void>;
  exit: (code: number) => void;
  logger: ShutdownLogger;
  appCloseTimeoutMs?: number;
}

/**
 * Returns the signal handler for the API process. It runs once: a second
 * SIGTERM or SIGINT while shutting down is ignored. Order: close the app
 * (bounded; a timeout logs at warn and shutdown continues), close the
 * database, exit 0. An error exits 1.
 */
export function createShutdownHandler(deps: ShutdownDeps): (signal: string) => Promise<void> {
  const timeoutMs = deps.appCloseTimeoutMs ?? APP_CLOSE_TIMEOUT_MS;
  let started = false;

  return async (signal: string) => {
    if (started) return;
    started = true;
    deps.logger.info({ signal }, 'API shutting down');
    try {
      let timer: NodeJS.Timeout | undefined;
      const closed = await Promise.race([
        deps.closeApp().then(() => true),
        new Promise<boolean>((resolve) => {
          timer = setTimeout(() => {
            resolve(false);
          }, timeoutMs);
        }),
      ]);
      clearTimeout(timer);
      if (!closed) {
        deps.logger.warn(
          { timeoutMs },
          'In-flight requests still running at shutdown; closing anyway',
        );
      }
      await deps.closeDatabase();
      deps.logger.info({ signal }, 'API graceful shutdown complete');
      deps.exit(0);
    } catch (err: unknown) {
      deps.logger.error({ err, signal }, 'API shutdown failed');
      deps.exit(1);
    }
  };
}
