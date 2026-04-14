// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import pino from 'pino';
import { ConnectionManager } from '../server/connection-manager.js';
import { PingMonitor } from '../server/ping-monitor.js';
import { createSessionState } from '../server/session-state.js';

const logger = pino({ level: 'silent' });

function mockWs() {
  return {
    close: vi.fn(),
    send: vi.fn(),
    on: vi.fn(),
    ping: vi.fn(),
  } as unknown as import('ws').default;
}

describe('PingMonitor', () => {
  let cm: ConnectionManager;
  let monitor: PingMonitor;

  beforeEach(() => {
    vi.useFakeTimers();
    cm = new ConnectionManager(logger);
    monitor = new PingMonitor(cm, logger);
  });

  afterEach(async () => {
    await monitor.stop();
    vi.useRealTimers();
  });

  it('returns default snapshot when no pings have been sent', () => {
    const snapshot = monitor.getSnapshot();
    expect(snapshot.connectedStations).toBe(0);
    expect(snapshot.avgPingLatencyMs).toBe(0);
    expect(snapshot.maxPingLatencyMs).toBe(0);
    expect(snapshot.pingSuccessRate).toBe(100);
    expect(snapshot.totalPingsSent).toBe(0);
    expect(snapshot.totalPongsReceived).toBe(0);
  });

  it('records pong latency correctly', () => {
    cm.add('CS-001', mockWs(), createSessionState('CS-001'));
    monitor.start();

    // Trigger the ping interval
    vi.advanceTimersByTime(30_000);

    // Simulate time passing then pong received
    vi.advanceTimersByTime(15);
    monitor.recordPong('CS-001');

    const snapshot = monitor.getSnapshot();
    expect(snapshot.totalPingsSent).toBe(1);
    expect(snapshot.totalPongsReceived).toBe(1);
    expect(snapshot.avgPingLatencyMs).toBeGreaterThanOrEqual(0);
    expect(snapshot.pingSuccessRate).toBe(100);
  });

  it('calculates success rate correctly with missing pongs', () => {
    cm.add('CS-001', mockWs(), createSessionState('CS-001'));
    cm.add('CS-002', mockWs(), createSessionState('CS-002'));
    monitor.start();

    // First ping cycle
    vi.advanceTimersByTime(30_000);
    // Only CS-001 responds
    monitor.recordPong('CS-001');

    const snapshot = monitor.getSnapshot();
    expect(snapshot.totalPingsSent).toBe(2);
    expect(snapshot.totalPongsReceived).toBe(1);
    expect(snapshot.pingSuccessRate).toBe(50);
  });

  it('tracks connected stations count', () => {
    cm.add('CS-001', mockWs(), createSessionState('CS-001'));
    cm.add('CS-002', mockWs(), createSessionState('CS-002'));

    const snapshot = monitor.getSnapshot();
    expect(snapshot.connectedStations).toBe(2);
  });

  it('ignores pong for unknown station', () => {
    monitor.recordPong('UNKNOWN');
    const snapshot = monitor.getSnapshot();
    expect(snapshot.totalPongsReceived).toBe(0);
  });

  it('computes max latency', () => {
    cm.add('CS-001', mockWs(), createSessionState('CS-001'));
    cm.add('CS-002', mockWs(), createSessionState('CS-002'));
    monitor.start();

    // First ping cycle
    vi.advanceTimersByTime(30_000);

    vi.advanceTimersByTime(5);
    monitor.recordPong('CS-001');
    vi.advanceTimersByTime(20);
    monitor.recordPong('CS-002');

    const snapshot = monitor.getSnapshot();
    expect(snapshot.totalPongsReceived).toBe(2);
    expect(snapshot.maxPingLatencyMs).toBeGreaterThanOrEqual(snapshot.avgPingLatencyMs);
  });

  it('cleans up intervals on stop', async () => {
    monitor.start();
    await monitor.stop();
    // Advancing time should not trigger pings
    cm.add('CS-001', mockWs(), createSessionState('CS-001'));
    vi.advanceTimersByTime(60_000);
    const snapshot = monitor.getSnapshot();
    expect(snapshot.totalPingsSent).toBe(0);
  });

  it('handles ping failure by decrementing totalPingsSent', () => {
    const failingWs = {
      close: vi.fn(),
      send: vi.fn(),
      on: vi.fn(),
      ping: vi.fn(() => {
        throw new Error('Connection lost');
      }),
    } as unknown as import('ws').default;
    cm.add('CS-FAIL', failingWs, createSessionState('CS-FAIL'));
    monitor.start();

    vi.advanceTimersByTime(30_000);

    const snapshot = monitor.getSnapshot();
    // ping failed, so totalPingsSent should be 0 (incremented then decremented)
    expect(snapshot.totalPingsSent).toBe(0);
  });

  it('trims latency history when exceeding MAX_LATENCY_HISTORY', () => {
    cm.add('CS-001', mockWs(), createSessionState('CS-001'));
    monitor.start();

    // Simulate many ping/pong cycles
    for (let i = 0; i < 1100; i++) {
      vi.advanceTimersByTime(30_000);
      vi.advanceTimersByTime(5);
      monitor.recordPong('CS-001');
    }

    const snapshot = monitor.getSnapshot();
    expect(snapshot.totalPongsReceived).toBe(1100);
    // The internal recentLatencies array should have been trimmed
    // We verify indirectly: avgLatency should still be calculable
    expect(snapshot.avgPingLatencyMs).toBeGreaterThanOrEqual(0);
  });

  it('writeNow is a no-op when sql is null', () => {
    monitor.start();
    // Should not throw
    monitor.writeNow();
  });

  it('getSnapshot returns correct serverStartedAt date', () => {
    const snapshot = monitor.getSnapshot();
    expect(snapshot.serverStartedAt).toBeInstanceOf(Date);
  });

  it('ignores pong for station where ping was already consumed', () => {
    cm.add('CS-001', mockWs(), createSessionState('CS-001'));
    monitor.start();

    vi.advanceTimersByTime(30_000);
    vi.advanceTimersByTime(5);
    monitor.recordPong('CS-001');

    // Second pong for same station should be ignored (sentTime already deleted)
    monitor.recordPong('CS-001');

    const snapshot = monitor.getSnapshot();
    expect(snapshot.totalPongsReceived).toBe(1);
  });

  it('does not ping stations that have been removed', () => {
    const ws = mockWs();
    cm.add('CS-001', ws, createSessionState('CS-001'));
    monitor.start();

    cm.remove('CS-001');

    vi.advanceTimersByTime(30_000);

    const snapshot = monitor.getSnapshot();
    expect(snapshot.totalPingsSent).toBe(0);
  });

  describe('checkHeartbeats', () => {
    it('closes connection when heartbeat times out', () => {
      const ws = mockWs();
      const session = createSessionState('CS-001');
      // Set lastHeartbeat to 16 minutes ago (exceeds 15-minute timeout)
      session.lastHeartbeat = new Date(Date.now() - 16 * 60 * 1000);
      cm.add('CS-001', ws, session);
      monitor.start();

      // Advance to trigger the interval (pingAll + checkHeartbeats)
      vi.advanceTimersByTime(30_000);

      expect(ws.close).toHaveBeenCalledWith(1000, 'Heartbeat timeout');
    });

    it('does not close connection when heartbeat is recent', () => {
      const ws = mockWs();
      const session = createSessionState('CS-001');
      // lastHeartbeat is set to "now" by createSessionState
      cm.add('CS-001', ws, session);
      monitor.start();

      vi.advanceTimersByTime(30_000);

      expect(ws.close).not.toHaveBeenCalled();
    });

    it('skips stations removed between allStationIds and get', () => {
      const ws = mockWs();
      cm.add('CS-001', ws, createSessionState('CS-001'));
      monitor.start();

      // Remove the station right before the interval fires
      // We need to spy on allStationIds to return a stale id
      const originalGet = cm.get.bind(cm);
      vi.spyOn(cm, 'allStationIds').mockReturnValue(['CS-GHOST']);
      vi.spyOn(cm, 'get').mockImplementation((id: string) => {
        if (id === 'CS-GHOST') return undefined;
        return originalGet(id);
      });

      vi.advanceTimersByTime(30_000);

      // Should not throw, and no pings sent for ghost station
      const snapshot = monitor.getSnapshot();
      expect(snapshot.totalPingsSent).toBe(0);
    });
  });

  describe('writeSnapshot', () => {
    function mockSql() {
      const fn = vi.fn().mockResolvedValue([]);
      // Tagged template literal usage: sql`...` calls the function
      return fn as unknown as import('postgres').Sql;
    }

    function mockPubsub() {
      return {
        publish: vi.fn().mockResolvedValue(undefined),
        subscribe: vi.fn(),
        close: vi.fn(),
      };
    }

    it('writes initial snapshot on start when sql is provided', async () => {
      const sql = mockSql();
      monitor.start(sql);

      // The initial writeSnapshot is fired as a void promise.
      // Flush microtasks so the awaited sql call resolves.
      await vi.advanceTimersByTimeAsync(0);

      expect(sql).toHaveBeenCalled();
    });

    it('writes snapshot after pong wait on each cycle', async () => {
      const sql = mockSql();
      monitor.start(sql);

      // Clear the initial call
      (sql as unknown as ReturnType<typeof vi.fn>).mockClear();

      // Advance to trigger ping cycle
      vi.advanceTimersByTime(30_000);

      // Advance past PONG_WAIT_MS (5000ms) to trigger the scheduled write
      await vi.advanceTimersByTimeAsync(5_000);

      expect(sql).toHaveBeenCalled();
    });

    it('publishes csms_events after writing snapshot', async () => {
      const sql = mockSql();
      const pubsub = mockPubsub();
      monitor.start(sql, pubsub);

      // Flush the initial writeSnapshot void promise
      await vi.advanceTimersByTimeAsync(0);

      expect(pubsub.publish).toHaveBeenCalledWith(
        'csms_events',
        expect.stringContaining('"eventType":"ocpp.health"'),
      );
    });

    it('logs warning when writeSnapshot fails', async () => {
      const sql = vi
        .fn()
        .mockRejectedValue(new Error('DB down')) as unknown as import('postgres').Sql;
      const warnSpy = vi.spyOn(logger, 'warn');
      monitor.start(sql);

      // Flush the initial writeSnapshot void promise
      await vi.advanceTimersByTimeAsync(0);

      expect(warnSpy).toHaveBeenCalledWith(
        expect.objectContaining({ error: 'DB down' }),
        'Failed to write health snapshot',
      );
      warnSpy.mockRestore();
    });

    it('logs warning with stringified error for non-Error throws', async () => {
      const sql = vi.fn().mockRejectedValue('string error') as unknown as import('postgres').Sql;
      const warnSpy = vi.spyOn(logger, 'warn');
      monitor.start(sql);

      // Flush the initial writeSnapshot void promise
      await vi.advanceTimersByTimeAsync(0);

      expect(warnSpy).toHaveBeenCalledWith(
        expect.objectContaining({ error: 'string error' }),
        'Failed to write health snapshot',
      );
      warnSpy.mockRestore();
    });
  });

  describe('writeShutdownSnapshot', () => {
    function mockSql() {
      const fn = vi.fn().mockResolvedValue([]);
      return fn as unknown as import('postgres').Sql;
    }

    function mockPubsub() {
      return {
        publish: vi.fn().mockResolvedValue(undefined),
        subscribe: vi.fn(),
        close: vi.fn(),
      };
    }

    it('writes zeroed snapshot on stop when sql is provided', async () => {
      const sql = mockSql();
      monitor.start(sql);

      // Clear calls from start
      (sql as unknown as ReturnType<typeof vi.fn>).mockClear();

      await monitor.stop();

      expect(sql).toHaveBeenCalled();
    });

    it('publishes csms_events on shutdown', async () => {
      const sql = mockSql();
      const pubsub = mockPubsub();
      monitor.start(sql, pubsub);

      // Clear calls from start
      pubsub.publish.mockClear();

      await monitor.stop();

      expect(pubsub.publish).toHaveBeenCalledWith(
        'csms_events',
        expect.stringContaining('"eventType":"ocpp.health"'),
      );
    });

    it('logs warning when writeShutdownSnapshot fails', async () => {
      const sql = mockSql();
      monitor.start(sql);

      // Make subsequent calls fail
      (sql as unknown as ReturnType<typeof vi.fn>).mockRejectedValue(new Error('DB gone'));
      const warnSpy = vi.spyOn(logger, 'warn');

      await monitor.stop();

      expect(warnSpy).toHaveBeenCalledWith(
        expect.objectContaining({ error: 'DB gone' }),
        'Failed to write shutdown snapshot',
      );
      warnSpy.mockRestore();
    });

    it('logs warning with stringified error for non-Error throws on shutdown', async () => {
      const sql = mockSql();
      monitor.start(sql);

      (sql as unknown as ReturnType<typeof vi.fn>).mockRejectedValue(42);
      const warnSpy = vi.spyOn(logger, 'warn');

      await monitor.stop();

      expect(warnSpy).toHaveBeenCalledWith(
        expect.objectContaining({ error: '42' }),
        'Failed to write shutdown snapshot',
      );
      warnSpy.mockRestore();
    });
  });

  describe('writeNow with sql', () => {
    it('triggers writeSnapshot when sql is provided', async () => {
      const sql = vi.fn().mockResolvedValue([]) as unknown as import('postgres').Sql;
      monitor.start(sql);

      // Flush the initial write
      await vi.advanceTimersByTimeAsync(0);

      // Clear the initial write call
      (sql as unknown as ReturnType<typeof vi.fn>).mockClear();

      monitor.writeNow();

      // Flush the writeNow void promise
      await vi.advanceTimersByTimeAsync(0);

      expect(sql).toHaveBeenCalled();
    });
  });

  describe('start with sql schedules writes after pong wait', () => {
    it('clears pending write timeout on stop', async () => {
      const sql = vi.fn().mockResolvedValue([]) as unknown as import('postgres').Sql;
      monitor.start(sql);

      // Trigger ping cycle which schedules a pending write
      vi.advanceTimersByTime(30_000);

      // Stop before the PONG_WAIT_MS fires
      await monitor.stop();

      // Clear calls
      (sql as unknown as ReturnType<typeof vi.fn>).mockClear();

      // Advance past the would-be write timeout
      vi.advanceTimersByTime(10_000);

      // The pending write should have been cancelled, so no new sql calls
      // (stop already wrote the shutdown snapshot, but no further calls)
      expect(sql).not.toHaveBeenCalled();
    });
  });
});
