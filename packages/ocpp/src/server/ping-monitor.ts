// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import type { ConnectionManager } from './connection-manager.js';
import type { Logger, PubSubClient } from '@evtivity/lib';
import { MIN_HEARTBEAT_TIMEOUT_MS, heartbeatTimeoutFor } from '@evtivity/lib';
import type postgres from 'postgres';
import { randomUUID } from 'node:crypto';
import {
  OCPP_HEALTH_SNAPSHOT_INTERVAL_MS,
  deleteOcppInstanceHealth,
  pruneStaleOcppHealth,
  writeOcppInstanceHealth,
} from '@evtivity/database';

export interface HealthSnapshot {
  connectedStations: number;
  avgPingLatencyMs: number;
  maxPingLatencyMs: number;
  pingSuccessRate: number;
  totalPingsSent: number;
  totalPongsReceived: number;
  serverStartedAt: Date;
}

const MAX_LATENCY_HISTORY = 1000;
// Readers judge the freshness of each process's health row by this interval.
const PING_INTERVAL_MS = OCPP_HEALTH_SNAPSHOT_INTERVAL_MS;
const PONG_WAIT_MS = 5_000;
export class PingMonitor {
  private readonly pingSentTimes = new Map<string, number>();
  private readonly recentLatencies: number[] = [];
  private totalPingsSent = 0;
  private totalPongsReceived = 0;
  private readonly serverStartedAt = new Date();
  private cycleInterval: ReturnType<typeof setInterval> | null = null;
  private heartbeatTimeoutMs = MIN_HEARTBEAT_TIMEOUT_MS;
  private pendingWriteTimeout: ReturnType<typeof setTimeout> | null = null;
  // Snapshot writes in flight; stop() waits for them before deleting the row.
  private readonly writes = new Set<Promise<void>>();
  private lastPruneAt = 0;

  constructor(
    private readonly connectionManager: ConnectionManager,
    private readonly logger: Logger,
  ) {}

  private sql: postgres.Sql | null = null;
  private pubsub: PubSubClient | null = null;
  // Key of this process's ocpp_server_health row. The server passes the
  // connection registry instance ID; without one the process gets a unique ID.
  private instanceId = `ocpp-${randomUUID()}`;

  start(sql?: postgres.Sql | null, pubsub?: PubSubClient | null, instanceId?: string): void {
    this.sql = sql ?? null;
    this.pubsub = pubsub ?? null;
    if (instanceId != null && instanceId !== '') this.instanceId = instanceId;

    this.cycleInterval = setInterval(() => {
      this.pingAll();
      this.checkHeartbeats();

      if (this.sql != null) {
        // Wait for pongs to arrive before writing the snapshot
        this.pendingWriteTimeout = setTimeout(() => {
          this.writeNow();
        }, PONG_WAIT_MS);
      }
    }, PING_INTERVAL_MS);

    // Write initial snapshot on start
    this.writeNow();

    this.logger.info('Ping monitor started');
  }

  async stop(): Promise<void> {
    if (this.cycleInterval != null) clearInterval(this.cycleInterval);
    if (this.pendingWriteTimeout != null) clearTimeout(this.pendingWriteTimeout);
    this.cycleInterval = null;
    this.pendingWriteTimeout = null;

    // Delete this process's row so the fleet totals drop its stations. No
    // write starts after this point (the server closes the station sockets
    // after stopping the monitor, and each close calls writeNow), and a write
    // still running finishes first, so it cannot recreate the row.
    const sql = this.sql;
    this.sql = null;
    await Promise.allSettled([...this.writes]);
    if (sql != null) {
      await this.writeShutdownSnapshot(sql);
    }
  }

  getInstanceId(): string {
    return this.instanceId;
  }

  writeNow(): void {
    if (this.sql == null) return;
    const write = this.writeSnapshot(this.sql).finally(() => {
      this.writes.delete(write);
    });
    this.writes.add(write);
  }

  recordPong(stationId: string): void {
    const sentTime = this.pingSentTimes.get(stationId);
    if (sentTime == null) return;

    const latency = Date.now() - sentTime;
    this.recentLatencies.push(latency);
    this.totalPongsReceived++;
    this.pingSentTimes.delete(stationId);

    if (this.recentLatencies.length > MAX_LATENCY_HISTORY) {
      this.recentLatencies.splice(0, this.recentLatencies.length - MAX_LATENCY_HISTORY);
    }
  }

  getSnapshot(): HealthSnapshot {
    const latencies = this.recentLatencies;
    const avgLatency =
      latencies.length > 0 ? latencies.reduce((a, b) => a + b, 0) / latencies.length : 0;
    const maxLatency = latencies.length > 0 ? Math.max(...latencies) : 0;
    const successRate =
      this.totalPingsSent > 0 ? (this.totalPongsReceived / this.totalPingsSent) * 100 : 100;

    return {
      connectedStations: this.connectionManager.count(),
      avgPingLatencyMs: Math.round(avgLatency * 100) / 100,
      maxPingLatencyMs: maxLatency,
      pingSuccessRate: Math.round(successRate * 100) / 100,
      totalPingsSent: this.totalPingsSent,
      totalPongsReceived: this.totalPongsReceived,
      serverStartedAt: this.serverStartedAt,
    };
  }

  private pingAll(): void {
    for (const stationId of this.connectionManager.allStationIds()) {
      const conn = this.connectionManager.get(stationId);
      if (conn == null) continue;

      this.pingSentTimes.set(stationId, Date.now());
      this.totalPingsSent++;

      try {
        conn.ws.ping();
      } catch (err) {
        this.logger.debug(
          { err, stationId },
          'Ping send failed; skipping this station until the next round',
        );
        this.pingSentTimes.delete(stationId);
        this.totalPingsSent--;
      }
    }
  }

  setHeartbeatIntervalSeconds(heartbeatSeconds: number): void {
    this.heartbeatTimeoutMs = heartbeatTimeoutFor(heartbeatSeconds);
  }

  private checkHeartbeats(): void {
    const now = Date.now();
    for (const stationId of this.connectionManager.allStationIds()) {
      const conn = this.connectionManager.get(stationId);
      if (conn == null) continue;

      const elapsed = now - conn.session.lastHeartbeat.getTime();
      if (elapsed > this.heartbeatTimeoutMs) {
        this.logger.warn(
          { stationId, elapsedMs: elapsed, timeoutMs: this.heartbeatTimeoutMs },
          'Heartbeat timeout, closing connection',
        );
        conn.ws.close(1000, 'Heartbeat timeout');
      }
    }
  }

  private async publishHealthChanged(): Promise<void> {
    if (this.pubsub == null) return;
    const notify = JSON.stringify({
      eventType: 'ocpp.health',
      stationId: null,
      siteId: null,
      sessionId: null,
    });
    await this.pubsub.publish('csms_events', notify);
  }

  // Deletes this process's row so readers stop counting it at once.
  private async writeShutdownSnapshot(sql: postgres.Sql): Promise<void> {
    try {
      await deleteOcppInstanceHealth(sql, this.instanceId);
      await this.publishHealthChanged();
    } catch (err) {
      this.logger.warn(
        { error: err instanceof Error ? err.message : String(err) },
        'Failed to write shutdown snapshot',
      );
    }
  }

  private async writeSnapshot(sql: postgres.Sql): Promise<void> {
    const snapshot = this.getSnapshot();
    try {
      await writeOcppInstanceHealth(sql, this.instanceId, snapshot);
      // Rows of processes that died without their shutdown delete. At most
      // once per cycle: writeNow also runs on every connect and disconnect.
      const now = Date.now();
      if (now - this.lastPruneAt >= PING_INTERVAL_MS) {
        this.lastPruneAt = now;
        await pruneStaleOcppHealth(sql);
      }
      await this.publishHealthChanged();
    } catch (err) {
      this.logger.warn(
        { error: err instanceof Error ? err.message : String(err) },
        'Failed to write health snapshot',
      );
    }
  }
}
