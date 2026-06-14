// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { describe, it, expect, vi } from 'vitest';
import type postgres from 'postgres';
import { SimulatorManager } from '../simulator-manager.js';
import { StationSimulator, type StationConfig } from '../station-simulator.js';
import { STUCK_GRACE_MS, MAX_HEAL_PER_TICK, MAX_HEAL_ATTEMPTS } from '../simulator-heal.js';
import { noopSql, makeConfig } from './sim-test-helpers.js';

const STATION_ID = 'TEST-HEAL';
const CSS_PK = 'csspk1';

// Enabled css_stations rows plus their css_evses, branched by query text, so a
// sync cycle sees exactly the given stations (no real OCPP server or postgres).
function stationsSql(stations: Array<{ id: string; stationId: string }>): postgres.Sql {
  const fn = ((strings: TemplateStringsArray) => {
    const q = strings.join(' ');
    if (q.includes('FROM css_evses')) {
      return Promise.resolve(
        stations.map((s) => ({
          css_station_id: s.id,
          evse_id: 1,
          connector_id: 1,
          connector_type: 'ac_type2',
          max_power_w: 22000,
          phases: 3,
          voltage: 230,
        })),
      );
    }
    if (q.includes('FROM css_stations')) {
      return Promise.resolve(
        stations.map((s) => ({
          id: s.id,
          station_id: s.stationId,
          ocpp_protocol: 'ocpp2.1',
          security_profile: 0,
          target_url: 'ws://localhost:7103',
          password: null,
          model: 'M',
          serial_number: 'SN',
          firmware_version: '1.0',
          client_cert: null,
          client_key: null,
          ca_cert: null,
          vendor_name: 'V',
        })),
      );
    }
    return Promise.resolve([]);
  }) as unknown as postgres.Sql;
  return fn;
}

function oneStationSql(): postgres.Sql {
  return stationsSql([{ id: CSS_PK, stationId: STATION_ID }]);
}

// A StationSimulator with network/DB side effects stubbed and its readiness
// probes forced, so the manager's heal decision can be exercised in isolation.
// cssStationId (= config.id) must equal the css_stations row id so the sync
// loop treats it as the same running station.
function stubSim(opts: {
  ready: boolean;
  bootStatus: 'Accepted' | 'Pending' | 'Rejected' | null;
  notReadyMs: number;
  offline?: boolean;
  id?: string;
  stationId?: string;
}): StationSimulator {
  const sim = new StationSimulator(
    makeConfig({ id: opts.id ?? CSS_PK, stationId: opts.stationId ?? STATION_ID }),
    noopSql(),
  );
  Object.defineProperty(sim, 'isReady', { value: () => opts.ready, writable: true });
  Object.defineProperty(sim, 'getBootStatus', { value: () => opts.bootStatus, writable: true });
  Object.defineProperty(sim, 'getNotReadyMs', { value: () => opts.notReadyMs, writable: true });
  Object.defineProperty(sim, 'isOffline', { value: () => opts.offline ?? false, writable: true });
  Object.defineProperty(sim, 'start', { value: vi.fn(async () => {}), writable: true });
  Object.defineProperty(sim, 'stop', { value: vi.fn(async () => {}), writable: true });
  return sim;
}

async function runSync(manager: SimulatorManager): Promise<void> {
  await (manager as unknown as { syncStations(): Promise<void> }).syncStations();
}

describe('SimulatorManager self-heal', () => {
  it('restarts a stuck running station: stops the old one and recreates it', async () => {
    const replacement = stubSim({ ready: false, bootStatus: 'Accepted', notReadyMs: 0 });
    const factory = vi.fn(() => replacement);
    const manager = new SimulatorManager(oneStationSql(), undefined, factory);
    const stuck = stubSim({
      ready: false,
      bootStatus: 'Accepted',
      notReadyMs: STUCK_GRACE_MS + 10_000,
    });
    manager.simulators.set(STATION_ID, stuck);

    await runSync(manager);

    expect(stuck.stop).toHaveBeenCalledTimes(1);
    expect(factory).toHaveBeenCalledTimes(1);
    expect(replacement.start).toHaveBeenCalledTimes(1);
    expect(manager.simulators.get(STATION_ID)).toBe(replacement);
  });

  it('leaves a healthy (ready) station running and untouched', async () => {
    const factory = vi.fn(() => stubSim({ ready: true, bootStatus: 'Accepted', notReadyMs: 0 }));
    const manager = new SimulatorManager(oneStationSql(), undefined, factory);
    const healthy = stubSim({ ready: true, bootStatus: 'Accepted', notReadyMs: 0 });
    manager.simulators.set(STATION_ID, healthy);

    await runSync(manager);

    expect(healthy.stop).not.toHaveBeenCalled();
    expect(factory).not.toHaveBeenCalled();
    expect(manager.simulators.get(STATION_ID)).toBe(healthy);
  });

  it('never restarts a station awaiting onboarding approval (Pending)', async () => {
    const factory = vi.fn(() => stubSim({ ready: false, bootStatus: 'Pending', notReadyMs: 0 }));
    const manager = new SimulatorManager(oneStationSql(), undefined, factory);
    const pending = stubSim({
      ready: false,
      bootStatus: 'Pending',
      notReadyMs: STUCK_GRACE_MS + 10_000,
    });
    manager.simulators.set(STATION_ID, pending);

    await runSync(manager);

    expect(pending.stop).not.toHaveBeenCalled();
    expect(factory).not.toHaveBeenCalled();
    expect(manager.simulators.get(STATION_ID)).toBe(pending);
  });

  it('never restarts a station chaos deliberately parked offline (goOffline)', async () => {
    const factory = vi.fn(() => stubSim({ ready: false, bootStatus: 'Accepted', notReadyMs: 0 }));
    const manager = new SimulatorManager(oneStationSql(), undefined, factory);
    const offline = stubSim({
      ready: false,
      bootStatus: 'Accepted',
      notReadyMs: STUCK_GRACE_MS + 10_000,
      offline: true,
    });
    manager.simulators.set(STATION_ID, offline);

    await runSync(manager);

    expect(offline.stop).not.toHaveBeenCalled();
    expect(factory).not.toHaveBeenCalled();
    expect(manager.simulators.get(STATION_ID)).toBe(offline);
  });

  it('stops restarting a station once its attempt budget is exhausted', async () => {
    // The replacement is always still stuck, so the station never recovers.
    const factory = vi.fn(() =>
      stubSim({ ready: false, bootStatus: 'Accepted', notReadyMs: STUCK_GRACE_MS + 10_000 }),
    );
    const manager = new SimulatorManager(oneStationSql(), undefined, factory);
    manager.simulators.set(
      STATION_ID,
      stubSim({ ready: false, bootStatus: 'Accepted', notReadyMs: STUCK_GRACE_MS + 10_000 }),
    );

    for (let i = 0; i < MAX_HEAL_ATTEMPTS + 3; i++) await runSync(manager);

    expect(factory).toHaveBeenCalledTimes(MAX_HEAL_ATTEMPTS);
  });

  it('restarts at most MAX_HEAL_PER_TICK stuck stations in a single poll', async () => {
    const count = MAX_HEAL_PER_TICK + 5;
    const stations = Array.from({ length: count }, (_, i) => ({
      id: `pk${String(i)}`,
      stationId: `S-${String(i)}`,
    }));
    const factory = vi.fn((config: StationConfig) =>
      stubSim({
        ready: false,
        bootStatus: 'Accepted',
        notReadyMs: 0,
        id: config.id,
        stationId: config.stationId,
      }),
    );
    const manager = new SimulatorManager(stationsSql(stations), undefined, factory);
    for (const s of stations) {
      manager.simulators.set(
        s.stationId,
        stubSim({
          ready: false,
          bootStatus: 'Accepted',
          notReadyMs: STUCK_GRACE_MS + 10_000,
          id: s.id,
          stationId: s.stationId,
        }),
      );
    }

    await runSync(manager);

    expect(factory).toHaveBeenCalledTimes(MAX_HEAL_PER_TICK);
  });
});
