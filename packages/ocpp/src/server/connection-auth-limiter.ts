// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

/**
 * Bounds the station connection authentications (station lookup, password
 * check, connection log writes) that run at once. After an OCPP server restart
 * every station reconnects within seconds; without a bound their lookups fill
 * the database pool and the messages of stations already connected wait
 * behind them, or the database refuses new connections. Authentications over
 * the bound wait in a FIFO queue. When the queue is full, or a request waited
 * longer than maxWaitMs, the request is refused (the server answers 503 and
 * the station retries after its reconnect back-off).
 */

export interface ConnectionAuthLimits {
  /** Authentications that run at once. */
  maxConcurrent: number;
  /** Authentications that may wait for a free slot. */
  maxQueued: number;
  /** Longest wait for a slot before the request is refused. */
  maxWaitMs: number;
}

/** A request the limiter refused: the queue was full or the wait too long. */
export class ConnectionAuthBusyError extends Error {
  constructor(readonly reason: 'queue_full' | 'wait_timeout') {
    super(`Connection authentication busy (${reason})`);
    this.name = 'ConnectionAuthBusyError';
  }
}

export interface ConnectionAuthStats {
  active: number;
  queued: number;
  maxConcurrent: number;
  /** Requests refused since the server started. */
  rejected: number;
}

// Up to this many requests wait for a slot, for at most this long. A station
// waits for the upgrade response; a request older than this is likely one the
// station has given up on.
export const DEFAULT_CONNECTION_AUTH_MAX_QUEUED = 1000;
export const DEFAULT_CONNECTION_AUTH_MAX_WAIT_MS = 10_000;

/**
 * Half the database pool: authentications never take the connections the
 * messages of connected stations need. At least 1.
 */
export function defaultConnectionAuthConcurrency(poolMax: number): number {
  return Math.max(1, Math.floor(poolMax / 2));
}

/**
 * The limits set through OCPP_AUTH_MAX_CONCURRENT, OCPP_AUTH_MAX_QUEUED and
 * OCPP_AUTH_MAX_WAIT_MS. A limit left unset keeps its default.
 */
export function connectionAuthLimitsFromConfig(config: {
  OCPP_AUTH_MAX_CONCURRENT?: number | undefined;
  OCPP_AUTH_MAX_QUEUED?: number | undefined;
  OCPP_AUTH_MAX_WAIT_MS?: number | undefined;
}): Partial<ConnectionAuthLimits> {
  return {
    ...(config.OCPP_AUTH_MAX_CONCURRENT != null && {
      maxConcurrent: config.OCPP_AUTH_MAX_CONCURRENT,
    }),
    ...(config.OCPP_AUTH_MAX_QUEUED != null && { maxQueued: config.OCPP_AUTH_MAX_QUEUED }),
    ...(config.OCPP_AUTH_MAX_WAIT_MS != null && { maxWaitMs: config.OCPP_AUTH_MAX_WAIT_MS }),
  };
}

interface Waiter {
  start: () => void;
  timer: NodeJS.Timeout;
}

export class ConnectionAuthLimiter {
  private active = 0;
  private rejected = 0;
  private readonly queue: Waiter[] = [];

  constructor(private readonly limits: ConnectionAuthLimits) {}

  run<T>(task: () => Promise<T>): Promise<T> {
    if (this.active < this.limits.maxConcurrent) {
      return this.execute(task);
    }
    if (this.queue.length >= this.limits.maxQueued) {
      this.rejected++;
      return Promise.reject(new ConnectionAuthBusyError('queue_full'));
    }
    return new Promise<T>((resolve, reject) => {
      const waiter: Waiter = {
        start: () => {
          clearTimeout(waiter.timer);
          this.execute(task).then(resolve, reject);
        },
        timer: setTimeout(() => {
          const index = this.queue.indexOf(waiter);
          if (index >= 0) this.queue.splice(index, 1);
          this.rejected++;
          reject(new ConnectionAuthBusyError('wait_timeout'));
        }, this.limits.maxWaitMs),
      };
      waiter.timer.unref();
      this.queue.push(waiter);
    });
  }

  stats(): ConnectionAuthStats {
    return {
      active: this.active,
      queued: this.queue.length,
      maxConcurrent: this.limits.maxConcurrent,
      rejected: this.rejected,
    };
  }

  private async execute<T>(task: () => Promise<T>): Promise<T> {
    this.active++;
    try {
      return await task();
    } finally {
      this.active--;
      this.queue.shift()?.start();
    }
  }
}
