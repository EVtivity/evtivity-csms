// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { beforeEach, describe, expect, it, vi } from 'vitest';
import type postgres from 'postgres';

const h = vi.hoisted(() => ({
  findAutochargeVehicle: vi.fn(),
  isAutochargeEnabledForStation: vi.fn(),
  getCompanyPortalUrl: vi.fn(),
}));

vi.mock('@evtivity/database', () => h);

const {
  readVehicleCapture,
  recordSessionVehicleCapture,
  resolveAutochargeVehicle,
  linkAutochargeSession,
  linkCapturedVehicle,
  autochargeNoticeVariables,
} = await import('../../server/session-lifecycle/vehicle-capture.js');

interface Query {
  text: string;
  values: unknown[];
}

/** A tagged-template double: records each top-level query and answers queued rows. */
function fakeSql(rows: unknown[][] = []): { sql: postgres.Sql; queries: Query[] } {
  const queries: Query[] = [];
  const fragment = (strings: TemplateStringsArray, values: unknown[]): Query => ({
    text: strings.reduce(
      (acc, s, i) =>
        acc +
        s +
        (i < values.length
          ? typeof values[i] === 'object' && values[i] != null && 'text' in values[i]
            ? (values[i] as Query).text
            : '$'
          : ''),
      '',
    ),
    values,
  });
  const sql = (strings: TemplateStringsArray, ...values: unknown[]) => {
    const q = fragment(strings, values);
    return Object.assign(q, {
      then: (resolve: (v: unknown) => unknown) => {
        queries.push(q);
        return Promise.resolve(rows.shift() ?? []).then(resolve);
      },
    });
  };
  return { sql: sql as unknown as postgres.Sql, queries };
}

const VIN = { value: 'WVWZZZ1JZXW000001', type: 'VIN' as const, source: 'id_token' as const };

beforeEach(() => {
  vi.clearAllMocks();
});

describe('readVehicleCapture', () => {
  it('reads a capture of a known type and source', () => {
    expect(readVehicleCapture({ vehicleId: { ...VIN } })).toEqual(VIN);
  });

  it('reads nothing from a missing or malformed capture', () => {
    for (const vehicleId of [
      undefined,
      'VIN123',
      { value: '', type: 'VIN', source: 'id_token' },
      { value: 'x', type: 3, source: 'id_token' },
      { value: 'x', type: 'Plate', source: 'id_token' },
      { value: 'x', type: 'VIN', source: 'guess' },
      { value: 'x', type: 'VIN', source: 7 },
    ]) {
      expect(readVehicleCapture({ vehicleId })).toBeNull();
    }
  });
});

describe('recordSessionVehicleCapture', () => {
  it('stores the capture only while the session has none', async () => {
    const { sql, queries } = fakeSql();
    await recordSessionVehicleCapture(sql, 'ses_1', VIN);
    expect(queries[0]?.text).toMatch(/vehicle_id_value IS NULL/);
    expect(queries[0]?.values).toEqual([VIN.value, 'VIN', 'id_token', 'ses_1']);
  });
});

describe('resolveAutochargeVehicle', () => {
  const match = { vehicleId: 'veh_1', driverId: 'drv_1', blocked: false, driverIsActive: true };

  it('never authorizes from an additionalInfo entry or without a capture', async () => {
    expect(await resolveAutochargeVehicle('CS1', null)).toBeNull();
    expect(await resolveAutochargeVehicle('CS1', { ...VIN, source: 'additional_info' })).toBeNull();
    expect(h.findAutochargeVehicle).not.toHaveBeenCalled();
  });

  it('refuses an unknown or blocked vehicle, an inactive driver and a site without Autocharge', async () => {
    h.findAutochargeVehicle.mockResolvedValueOnce(null);
    expect(await resolveAutochargeVehicle('CS1', VIN)).toBeNull();
    h.findAutochargeVehicle.mockResolvedValueOnce({ ...match, blocked: true });
    expect(await resolveAutochargeVehicle('CS1', VIN)).toBeNull();
    h.findAutochargeVehicle.mockResolvedValueOnce({ ...match, driverIsActive: false });
    expect(await resolveAutochargeVehicle('CS1', VIN)).toBeNull();
    expect(h.isAutochargeEnabledForStation).not.toHaveBeenCalled();
    h.findAutochargeVehicle.mockResolvedValueOnce(match);
    h.isAutochargeEnabledForStation.mockResolvedValueOnce(false);
    expect(await resolveAutochargeVehicle('CS1', VIN)).toBeNull();
  });

  it('answers the vehicle and its driver', async () => {
    h.findAutochargeVehicle.mockResolvedValueOnce(match);
    h.isAutochargeEnabledForStation.mockResolvedValueOnce(true);
    expect(await resolveAutochargeVehicle('CS1', VIN)).toEqual({
      vehicleId: 'veh_1',
      driverId: 'drv_1',
    });
    expect(h.isAutochargeEnabledForStation).toHaveBeenCalledWith('CS1');
  });
});

describe('session links', () => {
  it('links an Autocharge session only while it has no other driver', async () => {
    const { sql, queries } = fakeSql();
    await linkAutochargeSession(sql, 'ses_1', { vehicleId: 'veh_1', driverId: 'drv_1' });
    expect(queries[0]?.text).toMatch(/driver_id IS NULL OR driver_id = \$/);
    expect(queries[0]?.values).toEqual(['drv_1', 'veh_1', 'ses_1', 'drv_1']);
  });

  it('matches the VIN column for a VIN and the EVCCID column for the others, the driver own only', async () => {
    const vin = fakeSql();
    await linkCapturedVehicle(vin.sql, 'ses_1', 'drv_1', VIN);
    expect(vin.queries[0]?.text).toMatch(/v\.vin = \$/);
    expect(vin.queries[0]?.text).toMatch(/v\.driver_id = \$/);
    const mac = fakeSql();
    await linkCapturedVehicle(mac.sql, 'ses_1', 'drv_1', {
      value: 'AABBCCDDEEFF',
      type: 'MacAddress',
      source: 'id_tag',
    });
    expect(mac.queries[0]?.text).toMatch(/v\.evccid = \$/);
    expect(mac.queries[0]?.text).not.toMatch(/v\.vin/);
  });
});

describe('autochargeNoticeVariables', () => {
  it('names the vehicle by year, make and model and links the portal vehicles page', async () => {
    const { sql } = fakeSql([[{ year: '2024', make: 'VW', model: ' ', license_plate: 'B-1' }]]);
    h.getCompanyPortalUrl.mockResolvedValueOnce('https://portal.example');
    expect(await autochargeNoticeVariables(sql, 'veh_1')).toEqual({
      vehicleName: '2024 VW',
      vehiclesUrl: 'https://portal.example/vehicles',
    });
  });

  it('falls back to the plate, then empty, and leaves the link out without a portal URL', async () => {
    const plate = fakeSql([[{ year: null, make: '', model: null, license_plate: 'B-1' }]]);
    h.getCompanyPortalUrl.mockResolvedValue(null);
    expect(await autochargeNoticeVariables(plate.sql, 'veh_1')).toEqual({
      vehicleName: 'B-1',
      vehiclesUrl: '',
    });
    const none = fakeSql([[]]);
    expect(await autochargeNoticeVariables(none.sql, 'veh_x')).toEqual({
      vehicleName: '',
      vehiclesUrl: '',
    });
  });
});
