// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

// The vehicle a driver session is linked to without a captured vehicle id:
// the card's vehicle, a depot driver's only vehicle, else the last vehicle.

import { describe, expect, it } from 'vitest';
import type postgres from 'postgres';
import { linkSessionVehicle } from '../server/session-lifecycle/session-vehicle-link.js';

interface Call {
  text: string;
  values: unknown[];
}

/** A tagged-template sql that answers the reads in order and records every call. */
function fakeSql(
  answers: Record<string, unknown>[][],
  opts: { sessionHasVehicle?: boolean } = {},
): { sql: postgres.Sql; calls: Call[] } {
  const calls: Call[] = [];
  const sql = ((strings: TemplateStringsArray, ...values: unknown[]) => {
    const text = strings.join('?');
    calls.push({ text, values });
    if (text.trim().startsWith('UPDATE')) {
      return Promise.resolve(opts.sessionHasVehicle === true ? [] : [{ id: 'ses_1' }]);
    }
    return Promise.resolve(answers.shift() ?? []);
  }) as unknown as postgres.Sql;
  return { sql, calls };
}

const updates = (calls: Call[]) => calls.filter((c) => c.text.trim().startsWith('UPDATE'));

describe('linkSessionVehicle', () => {
  it("links the card's vehicle first, only a vehicle of the same driver", async () => {
    const { sql, calls } = fakeSql([[{ vehicle_id: 'veh_card' }]]);
    expect(await linkSessionVehicle(sql, 'ses_1', 'drv_1')).toEqual({
      vehicleId: 'veh_card',
      rule: 'token',
    });
    expect(calls[0]?.text).toContain('v.driver_id =');
    expect(calls[0]?.values).toContain('drv_1');
    expect(updates(calls)[0]?.values).toEqual(['veh_card', 'ses_1']);
    // Nothing else is read once the card decides.
    expect(calls).toHaveLength(2);
  });

  it("links a depot driver's only vehicle when the card has none", async () => {
    const { sql, calls } = fakeSql([[], [{ depot_driver: true, vehicle_ids: ['veh_bus'] }]]);
    expect(await linkSessionVehicle(sql, 'ses_1', 'drv_1')).toEqual({
      vehicleId: 'veh_bus',
      rule: 'depot_only_vehicle',
    });
    expect(calls[1]?.text).toContain("layout_settings->>'siteType' = 'depot'");
    expect(updates(calls)[0]?.values).toEqual(['veh_bus', 'ses_1']);
  });

  it("decides the depot rule by the session's own station and site, after the card", async () => {
    const { sql, calls } = fakeSql([[], [{ depot_driver: false, vehicle_ids: ['veh_a'] }], []]);
    await linkSessionVehicle(sql, 'ses_1', 'drv_1');
    const depotRead = calls[1];
    // The session's station, a fleet holding that station, and the driver in that fleet.
    expect(depotRead?.text).toContain('FROM charging_sessions s');
    expect(depotRead?.text).toContain('cs.id = s.station_id');
    expect(depotRead?.text).toContain('fs.station_id = cs.id');
    expect(depotRead?.text).toContain('fd.fleet_id = fs.fleet_id');
    expect(depotRead?.values).toEqual(expect.arrayContaining(['drv_1', 'ses_1']));
  });

  it('never replaces a vehicle the session already has (an operator assigned it)', async () => {
    const { sql, calls } = fakeSql([[{ vehicle_id: 'veh_card' }]], { sessionHasVehicle: true });
    expect(await linkSessionVehicle(sql, 'ses_1', 'drv_1')).toEqual({
      vehicleId: null,
      rule: null,
    });
    expect(updates(calls)[0]?.text).toContain('vehicle_id IS NULL');
  });

  it('keeps an assigned vehicle for the depot and last vehicle rules too', async () => {
    const depot = fakeSql([[], [{ depot_driver: true, vehicle_ids: ['veh_bus'] }]], {
      sessionHasVehicle: true,
    });
    expect(await linkSessionVehicle(depot.sql, 'ses_1', 'drv_1')).toEqual({
      vehicleId: null,
      rule: null,
    });
    const last = fakeSql(
      [[], [{ depot_driver: false, vehicle_ids: [] }], [{ vehicle_id: 'veh_last' }]],
      { sessionHasVehicle: true },
    );
    expect(await linkSessionVehicle(last.sql, 'ses_1', 'drv_1')).toEqual({
      vehicleId: null,
      rule: null,
    });
    for (const c of [...updates(depot.calls), ...updates(last.calls)]) {
      expect(c.text).toContain('vehicle_id IS NULL');
    }
  });

  it('links nothing for a depot driver with several vehicles, never the last one', async () => {
    const { sql, calls } = fakeSql([[], [{ depot_driver: true, vehicle_ids: ['veh_a', 'veh_b'] }]]);
    expect(await linkSessionVehicle(sql, 'ses_1', 'drv_1')).toEqual({
      vehicleId: null,
      rule: null,
    });
    expect(updates(calls)).toHaveLength(0);
    expect(calls).toHaveLength(2);
  });

  it('keeps the last vehicle for every other driver', async () => {
    const { sql, calls } = fakeSql([
      [],
      [{ depot_driver: false, vehicle_ids: ['veh_a', 'veh_b'] }],
      [{ vehicle_id: 'veh_last' }],
    ]);
    expect(await linkSessionVehicle(sql, 'ses_1', 'drv_1')).toEqual({
      vehicleId: 'veh_last',
      rule: 'last_vehicle',
    });
    expect(calls[2]?.text).toContain('ORDER BY s.started_at DESC');
    expect(updates(calls)[0]?.values).toEqual(['veh_last', 'ses_1']);
  });

  it('carries over only a vehicle of the same driver, never a fleet-mate vehicle', async () => {
    const { sql, calls } = fakeSql([[], [{ depot_driver: false, vehicle_ids: [] }], []]);
    expect(await linkSessionVehicle(sql, 'ses_1', 'drv_1')).toEqual({
      vehicleId: null,
      rule: null,
    });
    // The last vehicle read joins the vehicle and keeps only the driver's own.
    expect(calls[2]?.text).toContain('JOIN vehicles v ON v.id = s.vehicle_id AND v.driver_id =');
    expect(calls[2]?.values).toEqual(['drv_1', 'drv_1', 'ses_1']);
    expect(updates(calls)).toHaveLength(0);
  });

  it('links nothing for a driver without any earlier vehicle', async () => {
    const { sql, calls } = fakeSql([[], [{ depot_driver: false, vehicle_ids: [] }], []]);
    expect(await linkSessionVehicle(sql, 'ses_1', 'drv_1')).toEqual({
      vehicleId: null,
      rule: null,
    });
    expect(updates(calls)).toHaveLength(0);
  });
});
