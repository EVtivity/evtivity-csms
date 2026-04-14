// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import type WebSocket from 'ws';
import type { SessionState } from './session-state.js';
import type { Logger, ConnectionRegistry } from '@evtivity/lib';

export interface StationConnection {
  ws: WebSocket;
  session: SessionState;
}

export interface ConnectionManagerOptions {
  registry?: ConnectionRegistry;
  instanceId?: string;
}

export class ConnectionManager {
  private readonly connections = new Map<string, StationConnection>();
  private readonly logger: Logger;
  private registry: ConnectionRegistry | null;
  private instanceId: string | null;

  constructor(logger: Logger, options?: ConnectionManagerOptions) {
    this.logger = logger;
    this.registry = options?.registry ?? null;
    this.instanceId = options?.instanceId ?? null;
  }

  setRegistry(registry: ConnectionRegistry, instanceId: string): void {
    this.registry = registry;
    this.instanceId = instanceId;
  }

  add(stationId: string, ws: WebSocket, session: SessionState): void {
    const existing = this.connections.get(stationId);
    if (existing != null) {
      this.logger.warn({ stationId }, 'Replacing existing connection');
      existing.ws.close(1000, 'Replaced by new connection');
    }
    this.connections.set(stationId, { ws, session });
    this.logger.info({ stationId, total: this.connections.size }, 'Station connected');

    if (this.registry != null && this.instanceId != null) {
      void this.registry.register(stationId, this.instanceId).catch(() => {
        // Non-critical: registry update failure should not block connection
      });
    }
  }

  remove(stationId: string): void {
    this.connections.delete(stationId);
    this.logger.info({ stationId, total: this.connections.size }, 'Station disconnected');

    if (this.registry != null) {
      void this.registry.unregister(stationId).catch(() => {
        // Non-critical
      });
    }
  }

  get(stationId: string): StationConnection | undefined {
    return this.connections.get(stationId);
  }

  has(stationId: string): boolean {
    return this.connections.has(stationId);
  }

  count(): number {
    return this.connections.size;
  }

  allStationIds(): string[] {
    return [...this.connections.keys()];
  }
}
