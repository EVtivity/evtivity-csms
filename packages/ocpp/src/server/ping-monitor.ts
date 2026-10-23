// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import type WebSocket from 'ws';
import type { ConnectionManager } from './connection-manager.js';
import type { DataPlan, DataPlanValues, Logger, PubSubClient } from '@evtivity/lib';
import { DATA_PLAN_DEFAULTS, heartbeatTimeoutFor } from '@evtivity/lib';
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
// A station that answered a ping on its connection is closed after this many
// CSMS ping intervals without any frame.
export const MISSED_PING_CLOSE_FACTOR = 3;

export class PingMonitor {
  private readonly pingSentTimes = new Map<string, number>();
  private readonly recentLatencies: number[] = [];
  private totalPingsSent = 0;
  private totalPongsReceived = 0;
  private readonly serverStartedAt = new Date();
  private cycleInterval: ReturnType<typeof setInterval> | null = null;
  // The values of both data plans; each connection follows its station's plan.
  private planValues: Readonly<Record<DataPlan, DataPlanValues>> = DATA_PLAN_DEFAULTS;
  private pendingWriteTimeout: ReturnType<typeof setTimeout> | null = null;
  // Snapshot writes in flight; stop() waits for them before deleting the row.
  private readonly writes = new Set<Promise<void>>();
  private lastPruneAt = 0;

  constructor(
    private readonly connectionManager: ConnectionManager,
    private readonly logger: Logger,
    /** Runs once per ping cycle, after the registry refresh. */
    private readonly onCycle?: () => void,
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
      this.pingDue();
      this.checkHeartbeats();
      // Keeps the connection registry entries of the stations this process
      // holds alive, whatever the heartbeat interval.
      this.connectionManager.refreshRegistry();
      this.onCycle?.();

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

  recordPong(stationId: string, ws?: WebSocket): void {
    // A pong proves the station answers pings: from now on a long silence
    // on this connection closes it (missed-pong close). A pong from a
    // replaced socket of the station never marks the current connection.
    const conn = this.connectionManager.get(stationId);
    if (conn != null && (ws == null || conn.ws === ws)) conn.session.answeredPing = true;
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

  setPlanValues(values: Readonly<Record<DataPlan, DataPlanValues>>): void {
    this.planValues = values;
  }

  /** The CSMS ping interval of a connection, from its station's data plan. */
  private pingIntervalMs(plan: DataPlan): number {
    return this.planValues[plan].csmsPingInterval * 1000;
  }

  /**
   * Pings each station only when no frame arrived from it for its plan's CSMS
   * ping interval, at the cycle whose next tick would pass the interval. Any
   * frame keeps the connection (and a carrier NAT mapping) alive, so a busy
   * or self-pinging station gets no CSMS ping. A station that answered a ping
   * on this connection and then sent nothing for 3 intervals is closed.
   */
  pingDue(now = Date.now()): void {
    for (const stationId of this.connectionManager.allStationIds()) {
      const conn = this.connectionManager.get(stationId);
      if (conn == null) continue;
      const intervalMs = this.pingIntervalMs(conn.session.dataPlan);
      const silentMs = now - conn.session.lastInboundAt.getTime();

      if (conn.session.answeredPing && silentMs > MISSED_PING_CLOSE_FACTOR * intervalMs) {
        this.logger.warn(
          { stationId, silentMs, pingIntervalMs: intervalMs },
          'No frame after a ping, closing connection',
        );
        this.pingSentTimes.delete(stationId);
        conn.ws.close(1000, 'Ping timeout');
        continue;
      }
      // Counted from the last frame or the last CSMS ping, whichever is
      // later, so a station that does not answer gets one ping per interval.
      const lastPingAt = conn.session.lastPingAt?.getTime() ?? 0;
      const sinceActivityMs = now - Math.max(conn.session.lastInboundAt.getTime(), lastPingAt);
      if (sinceActivityMs + PING_INTERVAL_MS <= intervalMs) continue;

      conn.session.lastPingAt = new Date(now);
      this.pingSentTimes.set(stationId, now);
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

  checkHeartbeats(now = Date.now()): void {
    for (const stationId of this.connectionManager.allStationIds()) {
      const conn = this.connectionManager.get(stationId);
      if (conn == null) continue;

      const timeoutMs = heartbeatTimeoutFor(
        this.planValues[conn.session.dataPlan].heartbeatInterval,
      );
      const elapsed = now - conn.session.lastHeartbeat.getTime();
      if (elapsed > timeoutMs) {
        this.logger.warn(
          { stationId, elapsedMs: elapsed, timeoutMs },
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
