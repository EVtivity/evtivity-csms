// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { Logger } from 'pino';
import type postgres from 'postgres';
import type { ConnectionRegistry, PubSubClient } from '@evtivity/lib';

const { mockFind, mockMark } = vi.hoisted(() => ({
  mockFind: vi.fn(),
  mockMark: vi.fn(),
}));

vi.mock('@evtivity/database', () => ({
  client: {},
  findStaleOnlineStations: mockFind,
  markStationOfflineIfStale: mockMark,
  getHeartbeatIntervalSeconds: vi.fn().mockResolvedValue(300),
  isRoamingEnabled: vi.fn().mockResolvedValue(false),
}));
vi.mock('@evtivity/services/template-dirs', () => ({ ALL_TEMPLATES_DIRS: [] }));

import { runStationOfflineSweep } from '../../handlers/station-offline-sweep.js';
import type { OfflineSweepDeps } from '../../handlers/station-offline-sweep.js';

const STALE_BEFORE = new Date('2026-10-06T12:00:00Z');
const STALE = new Date('2026-10-06T11:30:00Z');

function makeLog(): Logger {
  return { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() } as unknown as Logger;
}

function makeDeps(owners: Record<string, string | null>, reservations: unknown[] = []) {
  const publish = vi.fn().mockResolvedValue(undefined);
  const notifyDriver = vi.fn().mockResolvedValue(undefined);
  const roamingEnabled = vi.fn().mockResolvedValue(true);
  const sql = vi.fn().mockResolvedValue(reservations) as unknown as postgres.Sql;
  const registry: ConnectionRegistry = {
    register: vi.fn(),
    unregister: vi.fn(),
    getInstanceId: vi.fn((id: string) => Promise.resolve(owners[id] ?? null)),
  };
  const deps: OfflineSweepDeps = {
    sql,
    registry,
    pubsub: { publish } as unknown as PubSubClient,
    heartbeatSeconds: 300,
    roamingEnabled,
    notifyDriver,
  };
  return { deps, publish, notifyDriver, registry };
}

function candidate(id: string, lastActivityAt: Date | null = STALE) {
  return { id: `uuid-${id}`, stationId: id, lastActivityAt, staleBefore: STALE_BEFORE };
}

beforeEach(() => {
  mockFind.mockReset();
  mockMark.mockReset();
});

describe('runStationOfflineSweep', () => {
  it('queries candidates with the heartbeat timeout plus slack', async () => {
    mockFind.mockResolvedValue([]);
    const { deps } = makeDeps({});
    await runStationOfflineSweep(deps, makeLog());
    expect(mockFind).toHaveBeenCalledWith(deps.sql, 960_000);
  });

  it('never marks offline a stale station whose registry key exists', async () => {
    mockFind.mockResolvedValue([candidate('CS-1')]);
    const { deps, publish } = makeDeps({ 'CS-1': 'pod-a' });
    const result = await runStationOfflineSweep(deps, makeLog());
    expect(mockMark).not.toHaveBeenCalled();
    expect(publish).not.toHaveBeenCalled();
    expect(result).toEqual({ candidates: 1, markedOffline: 0 });
  });

  it('leaves a station with fresh activity and no key alone', async () => {
    mockFind.mockResolvedValue([candidate('CS-1', new Date('2026-10-06T12:00:05Z'))]);
    const { deps } = makeDeps({});
    await runStationOfflineSweep(deps, makeLog());
    expect(mockMark).not.toHaveBeenCalled();
  });

  it('marks a stale station without a key offline and publishes the disconnect effects', async () => {
    mockFind.mockResolvedValue([candidate('CS-1')]);
    mockMark.mockResolvedValue({ siteId: 'site-1' });
    const { deps, publish, notifyDriver } = makeDeps({}, [
      { id: 'res-1', driver_id: 'drv-1' },
      { id: 'res-2', driver_id: null },
    ]);
    const result = await runStationOfflineSweep(deps, makeLog());

    expect(mockMark).toHaveBeenCalledWith(deps.sql, 'uuid-CS-1', 960_000);
    expect(publish).toHaveBeenCalledWith(
      'csms_events',
      JSON.stringify({
        eventType: 'station.status',
        stationId: 'uuid-CS-1',
        siteId: 'site-1',
        sessionId: null,
      }),
    );
    expect(publish).toHaveBeenCalledWith(
      'ocpi_push',
      JSON.stringify({ type: 'location', siteId: 'site-1' }),
    );
    expect(notifyDriver).toHaveBeenCalledTimes(1);
    expect(notifyDriver).toHaveBeenCalledWith('drv-1', 'res-1', 'CS-1');
    expect(result).toEqual({ candidates: 1, markedOffline: 1 });
  });

  it('publishes nothing when another run already marked the station offline', async () => {
    mockFind.mockResolvedValue([candidate('CS-1')]);
    mockMark.mockResolvedValue(null);
    const { deps, publish } = makeDeps({});
    const result = await runStationOfflineSweep(deps, makeLog());
    expect(publish).not.toHaveBeenCalled();
    expect(result.markedOffline).toBe(0);
  });

  it('stops the run when the registry cannot be read', async () => {
    mockFind.mockResolvedValue([candidate('CS-1'), candidate('CS-2')]);
    const { deps, registry } = makeDeps({});
    vi.mocked(registry.getInstanceId).mockRejectedValue(new Error('NOPERM'));
    const log = makeLog();
    await runStationOfflineSweep(deps, log);
    expect(mockMark).not.toHaveBeenCalled();
    expect(registry.getInstanceId).toHaveBeenCalledTimes(1);
    expect(log.warn).toHaveBeenCalledTimes(1);
  });

  it('continues with the next station when one update fails', async () => {
    mockFind.mockResolvedValue([candidate('CS-1'), candidate('CS-2')]);
    mockMark.mockRejectedValueOnce(new Error('db')).mockResolvedValueOnce({ siteId: null });
    const { deps, publish } = makeDeps({});
    const result = await runStationOfflineSweep(deps, makeLog());
    expect(result.markedOffline).toBe(1);
    expect(publish).toHaveBeenCalledTimes(1);
  });

  it('keeps going when a publish fails (fail-open)', async () => {
    mockFind.mockResolvedValue([candidate('CS-1')]);
    mockMark.mockResolvedValue({ siteId: 'site-1' });
    const { deps, publish } = makeDeps({});
    publish.mockRejectedValue(new Error('redis down'));
    const log = makeLog();
    const result = await runStationOfflineSweep(deps, log);
    expect(result.markedOffline).toBe(1);
    expect(log.warn).toHaveBeenCalledTimes(2);
  });
});
