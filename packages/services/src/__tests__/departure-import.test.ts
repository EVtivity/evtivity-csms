// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { describe, expect, it, vi } from 'vitest';

vi.mock('@evtivity/database', () => ({ db: {} }));
vi.mock('../departure.service.js', () => ({
  createDeparture: vi.fn(),
  updateDeparture: vi.fn(),
  auditDeparturesImported: vi.fn(),
}));

import { ValidationError } from '@evtivity/lib';
import {
  DEPARTURE_IMPORT_MAX_BYTES,
  DEPARTURE_IMPORT_MAX_ROWS,
  importDepartures,
  parseCsv,
  type DepartureImportDeps,
} from '../departure-import.js';

const NOW = new Date('2026-11-02T10:00:00Z');
const STORED_AT = new Date('2026-11-01T08:00:00Z');
const actor = { actor: 'operator' as const, actorUserId: 'usr_1' };

function ctx(siteScope: string[] | null = null) {
  return { actor, siteScope, now: () => NOW };
}

const VEHICLES = [
  { id: 'veh_aaaaaaaaaaa1', licensePlate: 'BUS 101', vin: '1HGBH41JXMN109186' },
  { id: 'veh_aaaaaaaaaaa2', licensePlate: '=ABC', vin: null },
  { id: 'veh_aaaaaaaaaaa3', licensePlate: 'TWIN', vin: null },
  { id: 'veh_aaaaaaaaaaa4', licensePlate: 'twin', vin: null },
];
const SITES = [
  { id: 'sit_aaaaaaaaaaa1', name: 'North Depot', timezone: 'America/New_York' },
  { id: 'sit_aaaaaaaaaaa2', name: 'South Depot', timezone: 'UTC' },
];

function deps(overrides: Partial<DepartureImportDeps> = {}) {
  let n = 0;
  const base: DepartureImportDeps = {
    fleetVehicles: vi.fn(() => Promise.resolve(VEHICLES)),
    scopedSites: vi.fn((scope: string[] | null) =>
      Promise.resolve(scope == null ? SITES : SITES.filter((s) => scope.includes(s.id))),
    ),
    findMatchingDeparture: vi.fn(() => Promise.resolve(null)),
    createDeparture: vi.fn((input: { siteId: string }) => {
      n += 1;
      return Promise.resolve({ id: `vdp_${String(n)}`, siteId: input.siteId });
    }),
    updateDeparture: vi.fn((id: string) =>
      Promise.resolve({ id, siteId: 'sit_aaaaaaaaaaa2', updatedAt: NOW }),
    ),
    auditDeparturesImported: vi.fn(() => Promise.resolve()),
  };
  return { ...base, ...overrides };
}

describe('parseCsv', () => {
  it('reads quoted fields, escaped quotes, newlines in quotes, a BOM and CRLF', () => {
    const text = '﻿a,b\r\n"x, y","say ""hi"""\r\n"line\nbreak",z\r\n';
    expect(parseCsv(text)).toEqual([
      ['a', 'b'],
      ['x, y', 'say "hi"'],
      ['line\nbreak', 'z'],
    ]);
  });
});

describe('importDepartures', () => {
  it('creates departures, matching vehicles by plate, VIN or id and sites by name or id', async () => {
    const d = deps();
    const csv = [
      'Vehicle,Site,Departure,Energy kWh,SOC Percent,Priority',
      'bus 101,North Depot,2026-11-03 05:30,120,,8',
      '1hgbh41jxmn109186,sit_aaaaaaaaaaa2,2026-11-03T06:00:00Z,,80,',
      'veh_aaaaaaaaaaa2,south depot,2026-11-04T07:00:00+02:00,50.5,,',
    ].join('\n');
    const result = await importDepartures('flt_aaaaaaaaaaa1', csv, ctx(), d);
    expect(result).toEqual({ created: 3, updated: 0, unchanged: 0, refused: [] });
    const calls = vi.mocked(d.createDeparture).mock.calls.map((c) => c[0]);
    expect(calls[0]).toMatchObject({
      fleetId: 'flt_aaaaaaaaaaa1',
      vehicleId: 'veh_aaaaaaaaaaa1',
      siteId: 'sit_aaaaaaaaaaa1',
      // 05:30 in New York on 3 November 2026 (EST, UTC-5).
      departureAt: new Date('2026-11-03T10:30:00Z'),
      target: { kind: 'energy', targetKwh: 120 },
      priority: 8,
      source: 'import',
    });
    expect(calls[1]).toMatchObject({
      vehicleId: 'veh_aaaaaaaaaaa1',
      siteId: 'sit_aaaaaaaaaaa2',
      departureAt: new Date('2026-11-03T06:00:00Z'),
      target: { kind: 'soc', targetSoc: 80 },
    });
    expect(calls[1]).not.toHaveProperty('priority');
    expect(calls[2]).toMatchObject({
      vehicleId: 'veh_aaaaaaaaaaa2',
      departureAt: new Date('2026-11-04T05:00:00Z'),
      target: { kind: 'energy', targetKwh: 50.5 },
    });
    expect(d.auditDeparturesImported).toHaveBeenCalledWith(
      'flt_aaaaaaaaaaa1',
      [
        { siteId: 'sit_aaaaaaaaaaa1', created: 1, updated: 0 },
        { siteId: 'sit_aaaaaaaaaaa2', created: 2, updated: 0 },
      ],
      expect.anything(),
    );
  });

  it('reads +02:00, +0200 and Z offsets and refuses times that do not exist', async () => {
    const d = deps();
    const csv = [
      'vehicle,site,departure,energy_kwh',
      'BUS 101,North Depot,2026-11-04T07:00:00+02:00,10',
      'BUS 101,North Depot,2026-11-04T07:00+0200,10',
      'BUS 101,North Depot,2026-11-04T05:00:00.5Z,10',
      'BUS 101,North Depot,2026-02-30T05:00:00Z,10',
      'BUS 101,North Depot,2026-11-04T24:00:00Z,10',
      'BUS 101,North Depot,2026-11-04T05:60:00Z,10',
      'BUS 101,North Depot,2026-11-04T05:00:00+15:00,10',
      'BUS 101,North Depot,2026-11-04T05:00:00+02,10',
    ].join('\n');
    const result = await importDepartures('flt_x', csv, ctx(), d);
    expect(vi.mocked(d.createDeparture).mock.calls.map((c) => c[0].departureAt)).toEqual([
      new Date('2026-11-04T05:00:00Z'),
      new Date('2026-11-04T05:00:00Z'),
      new Date('2026-11-04T05:00:00.500Z'),
    ]);
    expect(result.refused).toEqual(
      [5, 6, 7, 8, 9].map((row) => ({ row, field: 'departure', reason: 'invalid' })),
    );
  });

  it('defers the stale marks to the end and marks each site once through the audit', async () => {
    const d = deps();
    const csv = [
      'vehicle,site,departure,energy_kwh',
      'BUS 101,North Depot,2026-11-03 05:30,10',
      'BUS 101,North Depot,2026-11-03 07:30,10',
    ].join('\n');
    await importDepartures('flt_x', csv, ctx(), d);
    for (const call of vi.mocked(d.createDeparture).mock.calls) {
      expect(call[1]).toMatchObject({ deferChangeEffects: true });
    }
    expect(d.auditDeparturesImported).toHaveBeenCalledTimes(1);
    expect(vi.mocked(d.auditDeparturesImported).mock.calls[0]?.[2]).not.toHaveProperty(
      'deferChangeEffects',
    );
  });

  it('audits the rows written before an unexpected failure, then rethrows it', async () => {
    let n = 0;
    const d = deps({
      createDeparture: vi.fn((input: { siteId: string }) => {
        n += 1;
        if (n === 2) return Promise.reject(new Error('database gone'));
        return Promise.resolve({ siteId: input.siteId });
      }),
    });
    const csv = [
      'vehicle,site,departure,energy_kwh',
      'BUS 101,North Depot,2026-11-03 05:30,10',
      'BUS 101,North Depot,2026-11-03 07:30,10',
    ].join('\n');
    await expect(importDepartures('flt_x', csv, ctx(), d)).rejects.toThrow('database gone');
    expect(d.auditDeparturesImported).toHaveBeenCalledWith(
      'flt_x',
      [{ siteId: 'sit_aaaaaaaaaaa1', created: 1, updated: 0 }],
      expect.anything(),
    );
  });

  it('accepts header variants', async () => {
    const d = deps();
    const csv = 'license_plate;site_name;departure_time;kwh\n';
    await expect(importDepartures('flt_x', csv, ctx(), d)).rejects.toThrow(ValidationError);
    const ok = 'Plate,Site Name,Departure At,Target kWh\nBUS 101,North Depot,2026-11-03 05:30,10\n';
    expect((await importDepartures('flt_x', ok, ctx(), d)).created).toBe(1);
  });

  it('keeps formula characters as text: they match a stored value and are never evaluated', async () => {
    const d = deps();
    const csv = [
      'vehicle,site,departure,energy_kwh',
      '=ABC,North Depot,2026-11-03 05:30,10',
      '=HYPERLINK("http://x"),North Depot,2026-11-03 05:30,10',
      'BUS 101,North Depot,2026-11-03 05:30,=1+1',
    ].join('\n');
    const result = await importDepartures('flt_x', csv, ctx(), d);
    expect(result.created).toBe(1);
    expect(vi.mocked(d.createDeparture).mock.calls[0]?.[0]).toMatchObject({
      vehicleId: 'veh_aaaaaaaaaaa2',
    });
    expect(result.refused).toEqual([
      { row: 3, field: 'vehicle', reason: 'not_found' },
      { row: 4, field: 'energy_kwh', reason: 'invalid' },
    ]);
  });

  it('refuses rows by row number and field only, never echoing a value', async () => {
    const d = deps();
    const csv = [
      'vehicle,site,departure,energy_kwh,soc_percent,priority',
      ',North Depot,2026-11-03 05:30,10,,',
      'TWIN,North Depot,2026-11-03 05:30,10,,',
      'BUS 101,Secret Depot,2026-11-03 05:30,10,,',
      'BUS 101,North Depot,tomorrow,10,,',
      'BUS 101,North Depot,2026-11-03 05:30,,,',
      'BUS 101,North Depot,2026-11-03 05:30,10,80,',
      'BUS 101,North Depot,2026-11-03 05:30,10,,11',
      'BUS 101,North Depot,2026-02-30 05:30,10,,',
    ].join('\n');
    const result = await importDepartures('flt_x', csv, ctx(), d);
    expect(result.created).toBe(0);
    expect(result.refused).toEqual([
      { row: 2, field: 'vehicle', reason: 'missing' },
      { row: 3, field: 'vehicle', reason: 'ambiguous' },
      { row: 4, field: 'site', reason: 'not_found' },
      { row: 5, field: 'departure', reason: 'invalid' },
      { row: 6, field: 'energy_kwh', reason: 'missing' },
      { row: 7, field: 'soc_percent', reason: 'invalid' },
      { row: 8, field: 'priority', reason: 'invalid' },
      { row: 9, field: 'departure', reason: 'invalid' },
    ]);
    expect(JSON.stringify(result)).not.toContain('Secret');
    expect(d.auditDeparturesImported).not.toHaveBeenCalled();
  });

  it("checks every row against the caller's sites", async () => {
    const d = deps();
    const csv = [
      'vehicle,site,departure,energy_kwh',
      'BUS 101,North Depot,2026-11-03 05:30,10',
      'BUS 101,sit_aaaaaaaaaaa2,2026-11-03 05:30,10',
    ].join('\n');
    const result = await importDepartures('flt_x', csv, ctx(['sit_aaaaaaaaaaa1']), d);
    expect(d.scopedSites).toHaveBeenCalledWith(['sit_aaaaaaaaaaa1']);
    expect(result.created).toBe(1);
    expect(result.refused).toEqual([{ row: 3, field: 'site', reason: 'not_found' }]);
  });

  it('reads the optional expected arrival and its state of charge', async () => {
    const d = deps();
    const csv = [
      'vehicle,site,departure,soc_percent,expected_arrival,arrival_soc',
      'BUS 101,South Depot,2026-11-03T06:00:00Z,80,2026-11-03 01:15,35',
      'veh_aaaaaaaaaaa2,South Depot,2026-11-03T07:00:00Z,80,,',
    ].join('\n');
    const result = await importDepartures('flt_x', csv, ctx(), d);
    expect(result.refused).toEqual([]);
    const calls = vi.mocked(d.createDeparture).mock.calls.map((c) => c[0]);
    expect(calls[0]).toMatchObject({
      expectedArrivalAt: new Date('2026-11-03T01:15:00Z'),
      expectedArrivalSocPercent: 35,
    });
    expect(calls[1]).not.toHaveProperty('expectedArrivalAt');
    expect(calls[1]).not.toHaveProperty('expectedArrivalSocPercent');
  });

  it('refuses a bad expected arrival or arrival state of charge by its column', async () => {
    const d = deps({
      createDeparture: vi.fn(() =>
        Promise.reject(
          new ValidationError('The expected arrival is before the departure', {
            field: 'expectedArrivalAt',
          }),
        ),
      ),
    });
    const csv = [
      'vehicle,site,departure,soc_percent,arrival,arrival_soc_percent',
      'BUS 101,South Depot,2026-11-03T06:00:00Z,80,yesterday,',
      'BUS 101,South Depot,2026-11-03T06:00:00Z,80,,101',
      'BUS 101,South Depot,2026-11-03T06:00:00Z,80,2026-11-03T07:00:00Z,',
    ].join('\n');
    const result = await importDepartures('flt_x', csv, ctx(), d);
    expect(result.refused).toEqual([
      { row: 2, field: 'arrival', reason: 'invalid' },
      { row: 3, field: 'arrival_soc_percent', reason: 'invalid' },
      { row: 4, field: 'arrival', reason: 'invalid' },
    ]);
  });

  it('maps a refusal of the departure service to the row and its field', async () => {
    const d = deps({
      createDeparture: vi.fn(() =>
        Promise.reject(
          new ValidationError('A departure is 5 minutes to 30 days ahead', {
            field: 'departureAt',
          }),
        ),
      ),
    });
    const csv = 'vehicle,site,departure,soc_percent\nBUS 101,North Depot,2026-11-03 05:30,80\n';
    const result = await importDepartures('flt_x', csv, ctx(), d);
    expect(result.refused).toEqual([{ row: 2, field: 'departure', reason: 'invalid' }]);
  });

  it('updates a manual or imported departure of the same vehicle within 10 minutes (re-import)', async () => {
    const d = deps({
      findMatchingDeparture: vi.fn(() =>
        Promise.resolve({ id: 'vdp_existing', updatedAt: STORED_AT }),
      ),
      updateDeparture: vi
        .fn()
        .mockResolvedValueOnce({ id: 'vdp_existing', siteId: 'sit_aaaaaaaaaaa2', updatedAt: NOW })
        .mockResolvedValueOnce({
          id: 'vdp_existing',
          siteId: 'sit_aaaaaaaaaaa2',
          updatedAt: STORED_AT,
        }),
    });
    const csv = [
      'vehicle,site,departure,energy_kwh',
      'BUS 101,South Depot,2026-11-03T06:05:00Z,90',
      'BUS 101,South Depot,2026-11-03T06:05:00Z,90',
    ].join('\n');
    const result = await importDepartures('flt_x', csv, ctx(), d);
    expect(result).toEqual({ created: 0, updated: 1, unchanged: 1, refused: [] });
    expect(d.findMatchingDeparture).toHaveBeenCalledWith(
      'veh_aaaaaaaaaaa1',
      'sit_aaaaaaaaaaa2',
      new Date('2026-11-03T06:05:00Z'),
    );
    expect(d.updateDeparture).toHaveBeenCalledWith(
      'vdp_existing',
      {
        departureAt: new Date('2026-11-03T06:05:00Z'),
        target: { kind: 'energy', targetKwh: 90 },
      },
      expect.anything(),
    );
    expect(d.createDeparture).not.toHaveBeenCalled();
  });

  it(`refuses a file with more than ${String(DEPARTURE_IMPORT_MAX_ROWS)} rows and writes nothing`, async () => {
    const d = deps();
    const rows = Array.from(
      { length: DEPARTURE_IMPORT_MAX_ROWS + 1 },
      () => 'BUS 101,North Depot,2026-11-03 05:30,10',
    );
    const csv = ['vehicle,site,departure,energy_kwh', ...rows].join('\n');
    await expect(importDepartures('flt_x', csv, ctx(), d)).rejects.toThrow(/at most 2000 rows/);
    expect(d.createDeparture).not.toHaveBeenCalled();
    const exact = ['vehicle,site,departure,energy_kwh', ...rows.slice(1)].join('\n');
    expect((await importDepartures('flt_x', exact, ctx(), d)).created).toBe(2000);
  });

  it('refuses a file over the size cap and a file without the required columns', async () => {
    const d = deps();
    const big = 'vehicle,site,departure,energy_kwh\n' + 'x'.repeat(DEPARTURE_IMPORT_MAX_BYTES);
    await expect(importDepartures('flt_x', big, ctx(), d)).rejects.toThrow(ValidationError);
    await expect(
      importDepartures('flt_x', 'vehicle,site,energy_kwh\nBUS 101,North Depot,10\n', ctx(), d),
    ).rejects.toThrow(/departure/);
    await expect(importDepartures('flt_x', '', ctx(), d)).rejects.toThrow(ValidationError);
    expect(d.fleetVehicles).not.toHaveBeenCalled();
  });
});
