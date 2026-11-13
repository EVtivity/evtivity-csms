// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

// Departure CSV import edges: how each service refusal maps to a row field,
// updates with arrival fields, ambiguous site names, impossible times, and the
// default database readers.

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { AppError, ValidationError } from '@evtivity/lib';
import type { FakeDb } from './helpers/fake-db.js';
import { opArgs, sqlParams } from './helpers/fake-db.js';

const h = vi.hoisted(() => ({ fake: undefined as unknown as FakeDb }));

vi.mock('@evtivity/database', async () => {
  const { createFakeDb, fakeDatabaseModule } = await import('./helpers/fake-db.js');
  h.fake = createFakeDb();
  return fakeDatabaseModule(h.fake);
});
vi.mock('../departure.service.js', () => ({
  createDeparture: vi.fn(),
  updateDeparture: vi.fn(),
  auditDeparturesImported: vi.fn(),
}));

const { importDepartures, defaultDepartureImportDeps } = await import('../departure-import.js');
type Deps = typeof defaultDepartureImportDeps;

const NOW = new Date('2026-11-02T10:00:00Z');
const STORED_AT = new Date('2026-11-01T08:00:00Z');
const ctx = {
  actor: { actor: 'operator' as const, actorUserId: 'usr_1' },
  siteScope: null,
  now: () => NOW,
};

const VEHICLES = [{ id: 'veh_aaaaaaaaaaa1', licensePlate: 'BUS 1', vin: null }];
const SITES = [
  { id: 'sit_aaaaaaaaaaa1', name: 'Depot', timezone: 'UTC' },
  { id: 'sit_aaaaaaaaaaa2', name: 'depot', timezone: 'UTC' },
  { id: 'sit_aaaaaaaaaaa3', name: 'Yard', timezone: 'UTC' },
];

function deps(overrides: Partial<Deps> = {}): Deps {
  return {
    fleetVehicles: vi.fn(() => Promise.resolve(VEHICLES)),
    scopedSites: vi.fn(() => Promise.resolve(SITES)),
    findMatchingDeparture: vi.fn(() => Promise.resolve(null)),
    createDeparture: vi.fn((input: { siteId: string }) =>
      Promise.resolve({ id: 'vdp_1', siteId: input.siteId }),
    ),
    updateDeparture: vi.fn((id: string) =>
      Promise.resolve({ id, siteId: 'sit_aaaaaaaaaaa3', updatedAt: NOW }),
    ),
    auditDeparturesImported: vi.fn(() => Promise.resolve()),
    ...overrides,
  };
}

const HEADER = 'vehicle,site,departure,energy_kwh,priority,arrival,arrival_soc';

beforeEach(() => {
  h.fake.reset();
});

describe('service refusals', () => {
  const cases: [Error, string, string][] = [
    [new ValidationError('x', { field: 'targetKwh' }), 'energy_kwh', 'invalid'],
    [new ValidationError('x', { field: 'targetSoc' }), 'soc_percent', 'invalid'],
    [new ValidationError('x', { field: 'priority' }), 'priority', 'invalid'],
    [new ValidationError('x', { field: 'expectedArrivalAt' }), 'arrival', 'invalid'],
    [
      new ValidationError('x', { field: 'expectedArrivalSocPercent' }),
      'arrival_soc_percent',
      'invalid',
    ],
    [new ValidationError('x'), 'departure', 'invalid'],
    [new AppError('x', 404, 'VEHICLE_NOT_IN_FLEET'), 'vehicle', 'not_found'],
    [new AppError('x', 404, 'SITE_NOT_FOUND'), 'site', 'not_found'],
    [new AppError('x', 404, 'DEPARTURE_NOT_FOUND'), 'departure', 'invalid'],
    [new AppError('x', 409, 'DEPARTURE_NOT_SCHEDULED'), 'departure', 'invalid'],
  ];

  it.each(cases)('maps %s to the row field', async (err, field, reason) => {
    const d = deps({ createDeparture: vi.fn(() => Promise.reject(err)) });
    const out = await importDepartures(
      'flt_1',
      `${HEADER}\nBUS 1,Yard,2026-11-03T05:00:00Z,40,,,`,
      ctx,
      d,
    );
    expect(out.refused).toEqual([{ row: 2, field, reason }]);
    expect(out.created).toBe(0);
    expect(d.auditDeparturesImported).not.toHaveBeenCalled();
  });

  it('rethrows any other error, after auditing the rows written before it', async () => {
    const create = vi
      .fn()
      .mockResolvedValueOnce({ id: 'vdp_1', siteId: 'sit_aaaaaaaaaaa3' })
      .mockRejectedValueOnce(new AppError('boom', 500, 'INTERNAL'));
    const d = deps({ createDeparture: create as never });
    await expect(
      importDepartures(
        'flt_1',
        `${HEADER}\nBUS 1,Yard,2026-11-03T05:00:00Z,40,,,\nBUS 1,Yard,2026-11-04T05:00:00Z,40,,,`,
        ctx,
        d,
      ),
    ).rejects.toThrow('boom');
    expect(d.auditDeparturesImported).toHaveBeenCalledWith(
      'flt_1',
      [{ siteId: 'sit_aaaaaaaaaaa3', created: 1, updated: 0 }],
      ctx,
    );
  });
});

describe('file checks', () => {
  it('refuses a file with neither an energy nor a SoC column', async () => {
    await expect(
      importDepartures(
        'flt_1',
        'vehicle,site,departure\nBUS 1,Yard,2026-11-03T05:00:00Z',
        ctx,
        deps(),
      ),
    ).rejects.toMatchObject({ code: 'VALIDATION_ERROR', details: { field: 'csv' } });
  });
});

describe('rows', () => {
  it('updates a matched departure with the priority and arrival fields, or counts it unchanged', async () => {
    const update = vi
      .fn()
      .mockResolvedValueOnce({ id: 'vdp_m', siteId: 'sit_aaaaaaaaaaa3', updatedAt: NOW })
      .mockResolvedValueOnce({ id: 'vdp_m', siteId: 'sit_aaaaaaaaaaa3', updatedAt: STORED_AT });
    const d = deps({
      findMatchingDeparture: vi.fn(() => Promise.resolve({ id: 'vdp_m', updatedAt: STORED_AT })),
      updateDeparture: update as never,
    });
    const out = await importDepartures(
      'flt_1',
      `${HEADER}\nBUS 1,Yard,2026-11-03T05:00:00Z,40,7,2026-11-03T01:00:00Z,20\nBUS 1,Yard,2026-11-03T05:00:00Z,40,,,`,
      ctx,
      d,
    );
    expect(out).toMatchObject({ created: 0, updated: 1, unchanged: 1, refused: [] });
    expect(update.mock.calls[0]![1]).toEqual({
      departureAt: new Date('2026-11-03T05:00:00Z'),
      target: { kind: 'energy', targetKwh: 40 },
      priority: 7,
      expectedArrivalAt: new Date('2026-11-03T01:00:00Z'),
      expectedArrivalSocPercent: 20,
    });
    expect(update.mock.calls[1]![1]).toEqual({
      departureAt: new Date('2026-11-03T05:00:00Z'),
      target: { kind: 'energy', targetKwh: 40 },
    });
  });

  it('creates with the arrival fields', async () => {
    const d = deps();
    await importDepartures(
      'flt_1',
      `${HEADER}\nBUS 1,Yard,2026-11-03T05:00:00Z,40,,2026-11-03T01:00:00+0100,55`,
      ctx,
      d,
    );
    expect(d.createDeparture).toHaveBeenCalledWith(
      expect.objectContaining({
        expectedArrivalAt: new Date('2026-11-03T00:00:00Z'),
        expectedArrivalSocPercent: 55,
        source: 'import',
      }),
      expect.objectContaining({ deferChangeEffects: true }),
    );
  });

  it('refuses ambiguous site names, impossible times and offsets, and bad arrival SoC', async () => {
    const d = deps();
    const rows = [
      'BUS 1,DEPOT,2026-11-03T05:00:00Z,40,,,',
      'BUS 1,Yard,2026-02-30T05:00:00Z,40,,,',
      'BUS 1,Yard,2026-11-03T24:00:00Z,40,,,',
      'BUS 1,Yard,2026-11-03T05:00:00+15:00,40,,,',
      'BUS 1,Yard,2026-11-03T05:00:00+02:60,40,,,',
      'BUS 1,Yard,03/11/2026,40,,,',
      'BUS 1,Yard,2026-11-03T05:00:00Z,40,,2026-11-03T99:00:00Z,',
      'BUS 1,Yard,2026-11-03T05:00:00Z,40,,,101',
      'BUS 1,Yard,2026-11-03T05:00:00Z,40,,,x',
    ];
    const out = await importDepartures('flt_1', [HEADER, ...rows].join('\n'), ctx, d);
    expect(out.refused).toEqual([
      { row: 2, field: 'site', reason: 'ambiguous' },
      { row: 3, field: 'departure', reason: 'invalid' },
      { row: 4, field: 'departure', reason: 'invalid' },
      { row: 5, field: 'departure', reason: 'invalid' },
      { row: 6, field: 'departure', reason: 'invalid' },
      { row: 7, field: 'departure', reason: 'invalid' },
      { row: 8, field: 'arrival', reason: 'invalid' },
      { row: 9, field: 'arrival_soc_percent', reason: 'invalid' },
      { row: 10, field: 'arrival_soc_percent', reason: 'invalid' },
    ]);
    expect(d.createDeparture).not.toHaveBeenCalled();
  });

  it('reads fractional seconds and a negative offset', async () => {
    const d = deps();
    await importDepartures(
      'flt_1',
      `${HEADER}\nBUS 1,Yard,2026-11-03T05:00:00.5-03:30,40,,,`,
      ctx,
      d,
    );
    expect(d.createDeparture).toHaveBeenCalledWith(
      expect.objectContaining({ departureAt: new Date('2026-11-03T08:30:00.500Z') }),
      expect.anything(),
    );
  });
});

describe('default readers', () => {
  it('reads the fleet vehicles through the fleet drivers', async () => {
    h.fake.queue('select:vehicles', VEHICLES);
    expect(await defaultDepartureImportDeps.fleetVehicles('flt_9')).toEqual(VEHICLES);
    const [call] = h.fake.find('select', 'vehicles');
    expect(opArgs(call, 'innerJoin')).toBeDefined();
    expect(await sqlParams(opArgs(call, 'where')?.[0])).toContain('flt_9');
  });

  it('reads every site, the scoped sites, or none for an empty scope', async () => {
    expect(await defaultDepartureImportDeps.scopedSites([])).toEqual([]);
    expect(h.fake.calls).toHaveLength(0);
    h.fake.queue('select:sites', SITES);
    expect(await defaultDepartureImportDeps.scopedSites(null)).toEqual(SITES);
    expect(opArgs(h.fake.calls[0], 'where')?.[0]).toBeUndefined();
    await defaultDepartureImportDeps.scopedSites(['sit_aaaaaaaaaaa1']);
    expect(await sqlParams(opArgs(h.fake.calls[1], 'where')?.[0])).toContain('sit_aaaaaaaaaaa1');
  });

  it('finds the nearest scheduled manual or import departure within the window', async () => {
    const at = new Date('2026-11-03T05:00:00Z');
    expect(await defaultDepartureImportDeps.findMatchingDeparture('veh_1', 'sit_1', at)).toBeNull();
    h.fake.queue('select:vehicle_departures', [{ id: 'vdp_1', updatedAt: STORED_AT }]);
    expect(await defaultDepartureImportDeps.findMatchingDeparture('veh_1', 'sit_1', at)).toEqual({
      id: 'vdp_1',
      updatedAt: STORED_AT,
    });
    const params = await sqlParams(opArgs(h.fake.calls[0], 'where')?.[0]);
    expect(params).toEqual(
      expect.arrayContaining(['veh_1', 'sit_1', 'scheduled', 'manual', 'import']),
    );
    expect(opArgs(h.fake.calls[0], 'limit')).toEqual([1]);
  });
});
