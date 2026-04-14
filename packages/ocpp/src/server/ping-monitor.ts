// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import type { ConnectionManager } from './connection-manager.js';
import type { Logger, PubSubClient } from '@evtivity/lib';
import type postgres from 'postgres';

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
const PING_INTERVAL_MS = 30_000;
const PONG_WAIT_MS = 5_000;
const HEARTBEAT_TIMEOUT_MS = 900_000; // 15 minutes (3x default 300s interval)

export class PingMonitor {
  private readonly pingSentTimes = new Map<string, number>();
  private readonly recentLatencies: number[] = [];
  private totalPingsSent = 0;
  private totalPongsReceived = 0;
  private readonly serverStartedAt = new Date();
  private cycleInterval: ReturnType<typeof setInterval> | null = null;
  private pendingWriteTimeout: ReturnType<typeof setTimeout> | null = null;

  constructor(
    private readonly connectionManager: ConnectionManager,
    private readonly logger: Logger,
  ) {}

  private sql: postgres.Sql | null = null;
  private pubsub: PubSubClient | null = null;

  start(sql?: postgres.Sql | null, pubsub?: PubSubClient | null): void {
    this.sql = sql ?? null;
    this.pubsub = pubsub ?? null;

    this.cycleInterval = setInterval(() => {
      this.pingAll();
      this.checkHeartbeats();

      if (this.sql != null) {
        const conn = this.sql;
        // Wait for pongs to arrive before writing the snapshot
        this.pendingWriteTimeout = setTimeout(() => {
          void this.writeSnapshot(conn);
        }, PONG_WAIT_MS);
      }
    }, PING_INTERVAL_MS);

    if (this.sql != null) {
      // Write initial snapshot on start
      void this.writeSnapshot(this.sql);
    }

    this.logger.info('Ping monitor started');
  }

  async stop(): Promise<void> {
    if (this.cycleInterval != null) clearInterval(this.cycleInterval);
    if (this.pendingWriteTimeout != null) clearTimeout(this.pendingWriteTimeout);
    this.cycleInterval = null;
    this.pendingWriteTimeout = null;

    // Write a zeroed snapshot so the dashboard reflects the server is down
    if (this.sql != null) {
      await this.writeShutdownSnapshot(this.sql);
    }
  }

  writeNow(): void {
    if (this.sql != null) {
      void this.writeSnapshot(this.sql);
    }
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
      } catch {
        this.pingSentTimes.delete(stationId);
        this.totalPingsSent--;
      }
    }
  }

  private checkHeartbeats(): void {
    const now = Date.now();
    for (const stationId of this.connectionManager.allStationIds()) {
      const conn = this.connectionManager.get(stationId);
      if (conn == null) continue;

      const elapsed = now - conn.session.lastHeartbeat.getTime();
      if (elapsed > HEARTBEAT_TIMEOUT_MS) {
        this.logger.warn(
          { stationId, elapsedMs: elapsed, timeoutMs: HEARTBEAT_TIMEOUT_MS },
          'Heartbeat timeout, closing connection',
        );
        conn.ws.close(1000, 'Heartbeat timeout');
      }
    }
  }

  private async writeShutdownSnapshot(sql: postgres.Sql): Promise<void> {
    try {
      await sql`
        UPDATE ocpp_server_health SET
          connected_stations = 0,
          avg_ping_latency_ms = 0,
          max_ping_latency_ms = 0,
          ping_success_rate = 100,
          total_pings_sent = 0,
          total_pongs_received = 0,
          updated_at = now()
        WHERE id = 'singleton'
      `;

      if (this.pubsub != null) {
        const notify = JSON.stringify({
          eventType: 'ocpp.health',
          stationId: null,
          siteId: null,
          sessionId: null,
        });
        await this.pubsub.publish('csms_events', notify);
      }
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
      await sql`
        INSERT INTO ocpp_server_health (
          id, connected_stations, avg_ping_latency_ms, max_ping_latency_ms,
          ping_success_rate, total_pings_sent, total_pongs_received,
          server_started_at, updated_at
        )
        VALUES (
          'singleton',
          ${snapshot.connectedStations},
          ${snapshot.avgPingLatencyMs},
          ${snapshot.maxPingLatencyMs},
          ${snapshot.pingSuccessRate},
          ${snapshot.totalPingsSent},
          ${snapshot.totalPongsReceived},
          ${snapshot.serverStartedAt.toISOString()},
          now()
        )
        ON CONFLICT (id) DO UPDATE SET
          connected_stations = EXCLUDED.connected_stations,
          avg_ping_latency_ms = EXCLUDED.avg_ping_latency_ms,
          max_ping_latency_ms = EXCLUDED.max_ping_latency_ms,
          ping_success_rate = EXCLUDED.ping_success_rate,
          total_pings_sent = EXCLUDED.total_pings_sent,
          total_pongs_received = EXCLUDED.total_pongs_received,
          server_started_at = EXCLUDED.server_started_at,
          updated_at = now()
      `;

      if (this.pubsub != null) {
        const notify = JSON.stringify({
          eventType: 'ocpp.health',
          stationId: null,
          siteId: null,
          sessionId: null,
        });
        await this.pubsub.publish('csms_events', notify);
      }
    } catch (err) {
      this.logger.warn(
        { error: err instanceof Error ? err.message : String(err) },
        'Failed to write health snapshot',
      );
    }
  }
}
