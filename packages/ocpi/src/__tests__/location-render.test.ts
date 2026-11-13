// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({
  selects: [] as unknown[][],
  removed: vi.fn(),
}));

function chain(): Record<string, unknown> {
  const c: Record<string, unknown> = {};
  for (const m of ['from', 'where', 'limit']) c[m] = () => c;
  c['then'] = (resolve: (v: unknown) => unknown) =>
    Promise.resolve(h.selects.shift() ?? []).then(resolve);
  return c;
}

vi.mock('@evtivity/database', () => ({
  db: { select: () => chain() },
  sites: {},
  chargingStations: {},
  evses: {},
  connectors: {},
  stationUnits: {},
  maintenanceEvents: {},
  ocpiLocationPublish: {},
  isStationLevelUnavailable: (s: { availability?: string }) => s.availability === 'inoperative',
  removedOcpiEvses: h.removed,
  isOperatorStation: () => ({}),
}));
vi.mock('../lib/config.js', () => ({ config: { OCPI_COUNTRY_CODE: 'US', OCPI_PARTY_ID: 'EVT' } }));

const {
  unitsOf,
  unitFields,
  loadSiteLocation,
  deletedSiteLocation,
  retiredConnectorsUpdatedAt,
  withTariffIds,
} = await import('../services/location-render.js');

const T1 = new Date('2026-11-01T00:00:00Z');
const T2 = new Date('2026-11-02T00:00:00Z');
const SITE = {
  id: 'sit_1',
  latitude: '52.1',
  longitude: '4.3',
  freeVendEnabled: false,
  updatedAt: T1,
};

beforeEach(() => {
  h.selects = [];
  h.removed.mockReset();
  h.removed.mockResolvedValue([]);
});

describe('unit helpers', () => {
  it('reads no units without ids and maps the ones named', async () => {
    expect((await unitsOf([null, null])).size).toBe(0);
    h.selects.push([{ id: 'unt_1', name: 'Box 1', updatedAt: T1 }]);
    const units = await unitsOf(['unt_1', 'unt_1', null]);
    expect(unitFields('unt_1', units)).toEqual({ unitName: 'Box 1', unitUpdatedAt: T1 });
    expect(unitFields('unt_x', units)).toEqual({});
    expect(unitFields(null, units)).toEqual({});
  });

  it('takes the latest change of the retired connectors only', () => {
    expect(retiredConnectorsUpdatedAt([{ retiredAt: null, updatedAt: T2 }])).toEqual({});
    expect(
      retiredConnectorsUpdatedAt([
        { retiredAt: T1, updatedAt: T1 },
        { retiredAt: T1, updatedAt: T2 },
        { retiredAt: null, updatedAt: new Date('2027-01-01') },
      ]),
    ).toEqual({ retiredConnectorsUpdatedAt: T2 });
  });
});

describe('loadSiteLocation', () => {
  it('publishes nothing for a missing site, one without coordinates or without any EVSE', async () => {
    expect(await loadSiteLocation('sit_1', 'LOC1')).toBeNull();
    h.selects.push([{ ...SITE, latitude: null }]);
    expect(await loadSiteLocation('sit_1', 'LOC1')).toBeNull();
    h.selects.push([SITE], []);
    expect(await loadSiteLocation('sit_1', 'LOC1')).toBeNull();
  });

  it('renders the stations, units, retired parts, maintenance coverage and the publish time', async () => {
    h.selects.push(
      [SITE],
      [
        {
          id: 'sta_1',
          stationId: 'CS-1',
          isOnline: true,
          onboardingStatus: 'accepted',
          updatedAt: T1,
        },
        {
          id: 'sta_2',
          stationId: 'CS-2',
          isOnline: false,
          onboardingStatus: 'blocked',
          availability: 'inoperative',
          updatedAt: T1,
        },
      ],
      [
        {
          id: 'evs_1',
          stationId: 'sta_1',
          evseId: 1,
          updatedAt: T1,
          unitId: 'unt_1',
          retiredAt: null,
        },
        {
          id: 'evs_2',
          stationId: 'sta_2',
          evseId: 1,
          updatedAt: T1,
          unitId: null,
          retiredAt: null,
        },
        { id: 'evs_3', stationId: 'sta_x', evseId: 2, updatedAt: T1, unitId: null, retiredAt: T2 },
      ],
      [
        {
          id: 'con_1',
          evseId: 'evs_1',
          connectorId: 1,
          retiredAt: null,
          updatedAt: T1,
          status: 'available',
        },
        {
          id: 'con_2',
          evseId: 'evs_1',
          connectorId: 2,
          retiredAt: T2,
          updatedAt: T2,
          status: 'available',
        },
      ],
      [{ id: 'unt_1', name: 'Box 1', updatedAt: T2 }],
      [{ affectedStationIds: ['sta_1'] }, { affectedStationIds: null }],
      [{ updatedAt: T2 }],
    );
    const out = await loadSiteLocation('sit_1', 'LOC1');
    expect(out?.stations).toEqual([
      { id: 'sta_1', freeVend: false },
      { id: 'sta_2', freeVend: false },
    ]);
    const [e1, e2, e3] = out?.input.evses ?? [];
    expect(e1).toMatchObject({
      stationOcppId: 'CS-1',
      stationOnline: true,
      unitName: 'Box 1',
      removed: false,
      retiredConnectorsUpdatedAt: T2,
    });
    expect(e1?.connectors.map((c) => c.id)).toEqual(['con_1']);
    expect(e2).toMatchObject({ removed: true, stationLevelUnavailable: true, connectors: [] });
    expect(e3).toMatchObject({ stationOcppId: 'sta_x', stationOnline: false, removed: true });
    expect(out?.input).toMatchObject({
      countryCode: 'US',
      partyId: 'EVT',
      publishUpdatedAt: T2,
      maintenance: { allAffected: true, affectedStationIds: new Set(['sta_1']) },
    });
  });

  it('renders only the removed EVSEs of a site without stations, no maintenance or publish row', async () => {
    h.removed.mockResolvedValue([
      {
        evseUid: 'US*EVT*E1',
        stationOcppId: 'CS-9',
        evseNumber: 1,
        removedAt: T1,
        connectors: [{ id: 'c', connectorId: 1 }],
      },
    ]);
    h.selects.push([SITE], [], [], []);
    const out = await loadSiteLocation('sit_1', 'LOC1');
    expect(out?.input.evses).toEqual([
      expect.objectContaining({
        id: 'US*EVT*E1',
        removed: true,
        connectors: [expect.objectContaining({ status: 'unavailable' })],
      }),
    ]);
    expect(out?.input).not.toHaveProperty('maintenance');
    expect(out?.input).not.toHaveProperty('publishUpdatedAt');
  });

  it('names only the affected stations when every window lists some', async () => {
    h.selects.push(
      [SITE],
      [
        {
          id: 'sta_1',
          stationId: 'CS-1',
          isOnline: true,
          onboardingStatus: 'accepted',
          updatedAt: T1,
        },
      ],
      [],
      [{ affectedStationIds: ['sta_1'] }, { affectedStationIds: ['sta_2'] }],
      [],
    );
    const out = await loadSiteLocation('sit_1', 'LOC1');
    expect(out?.input.maintenance).toEqual({
      allAffected: false,
      affectedStationIds: new Set(['sta_1', 'sta_2']),
    });
  });
});

describe('deletedSiteLocation', () => {
  const removedEvse = {
    evseUid: 'E1',
    stationOcppId: 'CS-1',
    evseNumber: 1,
    removedAt: '2026-11-01T00:00:00.000Z',
    connectors: [],
  };

  it('is null without removed EVSEs or coordinates', () => {
    expect(deletedSiteLocation({ site: SITE as never, removedEvses: [] }, 'LOC1')).toBeNull();
    expect(
      deletedSiteLocation(
        { site: { ...SITE, longitude: null } as never, removedEvses: [removedEvse as never] },
        'LOC1',
      ),
    ).toBeNull();
  });

  it('renders the removed EVSEs with dates parsed', () => {
    const out = deletedSiteLocation(
      {
        site: { ...SITE, updatedAt: '2026-11-01T00:00:00.000Z' } as never,
        removedEvses: [removedEvse as never],
      },
      'LOC1',
    );
    expect(out?.input.site.updatedAt).toEqual(T1);
    expect(out?.input.evses[0]?.updatedAt).toEqual(T1);
    expect(out?.stations).toEqual([]);
  });
});

describe('withTariffIds', () => {
  it('adds the tariff ids of each EVSE station and leaves the others', () => {
    const input = { evses: [{ stationId: 'sta_1' }, { stationId: 'sta_2' }] } as never;
    const out = withTariffIds(input, new Map([['sta_1', ['t1']]]));
    expect(out.evses).toEqual([{ stationId: 'sta_1', tariffIds: ['t1'] }, { stationId: 'sta_2' }]);
  });
});
