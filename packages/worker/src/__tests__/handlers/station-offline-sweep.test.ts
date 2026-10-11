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
vi.mock('@evtivity/services/reservation-expiry', () => ({
  cancelHoldsForStationOutage: vi.fn(),
}));
vi.mock('@evtivity/services/reservation-notify', () => ({ notifyReservationDriver: vi.fn() }));
vi.mock('../../lib/payments.js', () => ({ paymentContext: vi.fn(() => ({})) }));

import { runStationOfflineSweep } from '../../handlers/station-offline-sweep.js';
import type { OfflineSweepDeps } from '../../handlers/station-offline-sweep.js';

const STALE_BEFORE = new Date('2026-10-06T12:00:00Z');
const STALE = new Date('2026-10-06T11:30:00Z');

function makeLog(): Logger {
  return { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() } as unknown as Logger;
}

function makeDeps(owners: Record<string, string | null>, reservations: unknown[] = []) {
  const publish = vi.fn().mockResolvedValue(undefined);
  const cancelHolds = vi.fn().mockResolvedValue(0);
  const notifyStationFaulted = vi.fn().mockResolvedValue(undefined);
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
    cancelHolds,
    notifyStationFaulted,
  };
  return { deps, publish, cancelHolds, notifyStationFaulted, sql, registry };
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
    const { deps, publish, notifyStationFaulted } = makeDeps({}, [
      { id: 'res-1', reservation_id: 11, driver_id: 'drv-1' },
      { id: 'res-2', reservation_id: 12, driver_id: null },
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
    expect(notifyStationFaulted).toHaveBeenCalledTimes(1);
    expect(notifyStationFaulted).toHaveBeenCalledWith({
      reservationDbId: 'res-1',
      reservationOcppId: 11,
      stationOcppId: 'CS-1',
      driverId: 'drv-1',
    });
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

  it('TC-RES-21: cancels the active holds of a station it marks offline, no fee, StationFaulted only for in_use', async () => {
    mockFind.mockResolvedValue([candidate('CS-1')]);
    mockMark.mockResolvedValue({ siteId: 'site-1' });
    const { deps, cancelHolds, notifyStationFaulted, sql } = makeDeps({}, [
      { id: 'res-in-use', reservation_id: 21, driver_id: 'drv-2' },
    ]);
    cancelHolds.mockResolvedValue(1);
    await runStationOfflineSweep(deps, makeLog());

    expect(cancelHolds).toHaveBeenCalledTimes(1);
    expect(cancelHolds).toHaveBeenCalledWith({
      stationUuid: 'uuid-CS-1',
      stationOcppId: 'CS-1',
      siteId: 'site-1',
      cause: 'offline',
    });
    // The fault notice reads only the holds in use: the active ones were cancelled.
    const sqlCalls = (sql as unknown as { mock: { calls: unknown[][] } }).mock.calls;
    const query = (sqlCalls[0]?.[0] as string[]).join('?');
    expect(query).toContain("status = 'in_use'");
    expect(query).not.toContain("'active'");
    expect(notifyStationFaulted).toHaveBeenCalledWith(
      expect.objectContaining({ reservationDbId: 'res-in-use', reservationOcppId: 21 }),
    );
  });

  it('TC-RES-21: does not cancel holds of a station it leaves online', async () => {
    mockFind.mockResolvedValue([candidate('CS-1')]);
    const { deps, cancelHolds } = makeDeps({ 'CS-1': 'pod-a' });
    await runStationOfflineSweep(deps, makeLog());
    expect(cancelHolds).not.toHaveBeenCalled();
  });

  it('TC-RES-21: keeps going when cancelling the holds fails (fail-open)', async () => {
    mockFind.mockResolvedValue([candidate('CS-1')]);
    mockMark.mockResolvedValue({ siteId: null });
    const { deps, cancelHolds, notifyStationFaulted } = makeDeps({}, [
      { id: 'res-in-use', reservation_id: 21, driver_id: 'drv-2' },
    ]);
    cancelHolds.mockRejectedValue(new Error('db'));
    const log = makeLog();
    const result = await runStationOfflineSweep(deps, log);
    expect(result.markedOffline).toBe(1);
    expect(notifyStationFaulted).toHaveBeenCalledTimes(1);
    expect(log.warn).toHaveBeenCalledTimes(1);
  });
});
