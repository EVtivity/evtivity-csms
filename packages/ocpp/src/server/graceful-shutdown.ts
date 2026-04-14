// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import type { WebSocketServer } from 'ws';
import type { Logger } from '@evtivity/lib';
import type { ConnectionManager } from './connection-manager.js';
import type { MessageCorrelator } from './message-correlator.js';

const SHUTDOWN_TIMEOUT_MS = 10_000;

export class GracefulShutdown {
  private readonly wss: WebSocketServer;
  private readonly connectionManager: ConnectionManager;
  private readonly correlator: MessageCorrelator;
  private readonly logger: Logger;
  private shuttingDown = false;

  constructor(
    wss: WebSocketServer,
    connectionManager: ConnectionManager,
    correlator: MessageCorrelator,
    logger: Logger,
  ) {
    this.wss = wss;
    this.connectionManager = connectionManager;
    this.correlator = correlator;
    this.logger = logger;
  }

  isShuttingDown(): boolean {
    return this.shuttingDown;
  }

  async shutdown(): Promise<void> {
    if (this.shuttingDown) return;
    this.shuttingDown = true;

    this.logger.info('Starting graceful shutdown');

    // Stop accepting new connections and close the underlying HTTP server
    const serverClosed = new Promise<void>((resolve) => {
      this.wss.close(() => {
        resolve();
      });
    });

    // Clear pending messages and close connections
    for (const stationId of this.connectionManager.allStationIds()) {
      const conn = this.connectionManager.get(stationId);
      if (conn != null) {
        this.correlator.clearPending(conn.session);
        conn.ws.close(1001, 'Server shutting down');
      }
    }

    // Wait for connections to close with timeout
    await new Promise<void>((resolve) => {
      const timeout = setTimeout(() => {
        this.logger.warn('Shutdown timeout reached, forcing close');
        for (const stationId of this.connectionManager.allStationIds()) {
          const conn = this.connectionManager.get(stationId);
          if (conn != null) {
            conn.ws.terminate();
          }
        }
        resolve();
      }, SHUTDOWN_TIMEOUT_MS);

      const check = (): void => {
        if (this.connectionManager.count() === 0) {
          clearTimeout(timeout);
          resolve();
        } else {
          setTimeout(check, 50);
        }
      };
      check();
    });

    // Ensure the HTTP server has fully closed
    await serverClosed;

    this.logger.info('Graceful shutdown complete');
  }
}
