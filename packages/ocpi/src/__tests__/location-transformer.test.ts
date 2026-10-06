// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { describe, it, expect } from 'vitest';
import {
  transformLocation,
  transformEvseStandalone,
} from '../transformers/location.transformer.js';
import type { EvseRow } from '../transformers/location.transformer.js';

const updatedAt = new Date('2026-09-01T00:00:00Z');

const site = {
  id: 'sit_000000000001',
  name: 'Main Street',
  address: '1 Main St',
  city: 'Springfield',
  state: null,
  postalCode: null,
  country: 'US',
  latitude: '40.0',
  longitude: '-75.0',
  timezone: 'America/New_York',
  contactName: null,
  contactIsPublic: false,
  hoursOfOperation: null,
  updatedAt,
};

function evse(id: string, stationId: string, status: string, stationLevelUnavailable: boolean) {
  return {
    id,
    stationId,
    stationOcppId: stationId.toUpperCase(),
    evseId: 1,
    updatedAt,
    stationLevelUnavailable,
    connectors: [
      {
        id: `con_${id}`,
        connectorId: 1,
        connectorType: 'Type2',
        maxPowerKw: '22',
        maxCurrentAmps: null,
        status,
        updatedAt,
      },
    ],
  };
}

function location(evses: EvseRow[], stationIds: string[] = []) {
  return transformLocation(
    {
      site,
      evses,
      ocpiLocationId: 'LOC-1',
      countryCode: 'US',
      partyId: 'EVT',
      ...(stationIds.length > 0
        ? { maintenance: { allAffected: false, affectedStationIds: new Set(stationIds) } }
        : {}),
    },
    '2.2.1',
  );
}

describe('transformLocation EVSE status', () => {
  it('publishes an available connector on an available station as AVAILABLE', () => {
    const result = location([evse('evs_a', 'sta_a', 'available', false)]);
    expect(result.evses?.[0]?.status).toBe('AVAILABLE');
  });

  it('masks every EVSE of a station-level unavailable station as INOPERATIVE', () => {
    const result = location([
      evse('evs_a', 'sta_a', 'available', true),
      evse('evs_b', 'sta_b', 'available', false),
    ]);
    expect(result.evses?.map((e) => e.status)).toEqual(['INOPERATIVE', 'AVAILABLE']);
  });

  it('masks a connector fault on a station-level unavailable station as INOPERATIVE', () => {
    const result = location([evse('evs_a', 'sta_a', 'faulted', true)]);
    expect(result.evses?.[0]?.status).toBe('INOPERATIVE');
  });

  it('keeps the maintenance mask', () => {
    const result = location([evse('evs_a', 'sta_a', 'available', false)], ['sta_a']);
    expect(result.evses?.[0]?.status).toBe('INOPERATIVE');
  });

  it('reports every EVSE of a deleted station as REMOVED, over any mask', () => {
    const result = location(
      [
        { ...evse('evs_a', 'sta_a', 'faulted', true), removed: true },
        evse('evs_b', 'sta_b', 'available', false),
      ],
      ['sta_a'],
    );
    expect(result.evses?.map((e) => e.status)).toEqual(['REMOVED', 'AVAILABLE']);
  });

  it('reports every EVSE as REMOVED for an unpublished location', () => {
    const result = transformLocation(
      {
        site,
        evses: [evse('evs_a', 'sta_a', 'available', false)],
        ocpiLocationId: 'LOC-1',
        countryCode: 'US',
        partyId: 'EVT',
        allRemoved: true,
      },
      '2.3.0',
    );
    expect(result.evses?.map((e) => e.status)).toEqual(['REMOVED']);
  });

  it('puts each EVSE tariff ids on its connectors, and none when it has none', () => {
    const result = location([
      { ...evse('evs_a', 'sta_a', 'available', false), tariffIds: ['T-1'] },
      evse('evs_b', 'sta_b', 'available', false),
    ]);
    expect(result.evses?.[0]?.connectors[0]?.tariff_ids).toEqual(['T-1']);
    expect(result.evses?.[1]?.connectors[0]).not.toHaveProperty('tariff_ids');
  });

  it('uses the internal EVSE id as the uid', () => {
    const result = location([evse('evs_a', 'sta_a', 'available', false)]);
    expect(result.evses?.[0]?.uid).toBe('evs_a');
    expect(result.evses?.[0]?.evse_id).toBe('STA_A-EVSE-1');
  });
});

describe('transformEvseStandalone', () => {
  it('masks a station-level unavailable station as INOPERATIVE', () => {
    expect(transformEvseStandalone(evse('evs_a', 'sta_a', 'available', true), '2.2.1').status).toBe(
      'INOPERATIVE',
    );
  });

  it('masks an EVSE under maintenance as INOPERATIVE', () => {
    expect(
      transformEvseStandalone(evse('evs_a', 'sta_a', 'available', false), '2.2.1', true).status,
    ).toBe('INOPERATIVE');
  });
});

function withConnectors(statuses: string[], connectorType: string | null = 'Type2'): EvseRow {
  const base = evse('evs_m', 'sta_m', 'available', false);
  return {
    ...base,
    connectors: statuses.map((status, i) => ({
      id: `con_${String(i)}`,
      connectorId: i + 1,
      connectorType,
      maxPowerKw: null,
      maxCurrentAmps: null,
      status,
      updatedAt,
    })),
  };
}

describe('EVSE status from several connectors', () => {
  it.each([
    [[], 'UNKNOWN'],
    [['available', 'faulted', 'charging'], 'OUTOFORDER'],
    [['available', 'charging', 'suspended_ev'], 'CHARGING'],
    [['available', 'suspended_ev', 'reserved'], 'BLOCKED'],
    [['available', 'reserved', 'unavailable'], 'RESERVED'],
    [['available', 'unavailable'], 'INOPERATIVE'],
    [['preparing', 'finishing'], 'AVAILABLE'],
    [['mystery'], 'UNKNOWN'],
  ])('%j -> %s', (statuses, expected) => {
    expect(transformEvseStandalone(withConnectors(statuses), '2.2.1').status).toBe(expected);
  });
});

describe('connector mapping', () => {
  function connector(type: string | null, maxPowerKw: string | null = null) {
    const row = withConnectors(['available'], type);
    const c = row.connectors[0];
    if (c != null) c.maxPowerKw = maxPowerKw;
    return transformEvseStandalone(row, '2.3.0').connectors[0];
  }

  it('defaults an unknown connector type to a Type 2 three-phase socket at 22 kW', () => {
    expect(connector(null)).toMatchObject({
      standard: 'IEC_62196_T2',
      format: 'CABLE',
      power_type: 'AC_3_PHASE',
      max_voltage: 400,
      max_amperage: 55,
    });
    expect(connector(null)?.max_electric_power).toBeUndefined();
    expect(connector('SomethingElse')).toMatchObject({
      standard: 'IEC_62196_T2',
      format: 'SOCKET',
      power_type: 'AC_3_PHASE',
    });
  });

  it.each([
    ['CCS2', 'IEC_62196_T2_COMBO'],
    ['CCS1', 'IEC_62196_T1_COMBO'],
    ['CHAdeMO', 'CHADEMO'],
    ['GBT', 'GBT_DC'],
    ['Tesla', 'TESLA_S'],
    ['NACS', 'IEC_62196_T1_COMBO'],
  ])('maps DC connector %s to %s with a cable at 400 V', (type, standard) => {
    expect(connector(type, '150')).toMatchObject({
      standard,
      format: 'CABLE',
      power_type: 'DC',
      max_voltage: 400,
      max_amperage: 375,
      max_electric_power: 150000,
    });
  });

  it('maps AC Type 1 to a socket', () => {
    expect(connector('Type1', '7.4')).toMatchObject({
      standard: 'IEC_62196_T1',
      format: 'SOCKET',
      power_type: 'AC_3_PHASE',
      max_amperage: 19,
    });
  });
});

describe('transformLocation site fields', () => {
  it('refuses a site without coordinates', () => {
    expect(() =>
      transformLocation(
        {
          site: { ...site, latitude: null },
          evses: [],
          ocpiLocationId: 'LOC-1',
          countryCode: 'US',
          partyId: 'EVT',
        },
        '2.2.1',
      ),
    ).toThrow('Cannot transform OCPI Location for site sit_000000000001: missing coordinates');
  });

  it('publishes postal code, state and a public operator contact', () => {
    const loc = transformLocation(
      {
        site: {
          ...site,
          postalCode: '19104',
          state: 'PA',
          contactName: 'Ops Team',
          contactIsPublic: true,
        },
        evses: [],
        ocpiLocationId: 'LOC-1',
        countryCode: 'US',
        partyId: 'EVT',
      },
      '2.2.1',
    );
    expect(loc.postal_code).toBe('19104');
    expect(loc.state).toBe('PA');
    expect(loc.operator).toEqual({ name: 'Ops Team' });
  });

  it('keeps a private contact and missing address fields out', () => {
    const loc = transformLocation(
      {
        site: {
          ...site,
          address: null,
          city: null,
          country: null,
          contactName: 'Hidden',
          contactIsPublic: false,
        },
        evses: [],
        ocpiLocationId: 'LOC-1',
        countryCode: 'US',
        partyId: 'EVT',
      },
      '2.2.1',
    );
    expect(loc.operator).toBeUndefined();
    expect(loc.postal_code).toBeUndefined();
    expect(loc.state).toBeUndefined();
    expect(loc.address).toBe('Unknown');
    expect(loc.city).toBe('Unknown');
    expect(loc.country).toBe('US');
  });

  it('marks every EVSE INOPERATIVE when maintenance covers the whole site', () => {
    const loc = transformLocation(
      {
        site,
        evses: [evse('evs_a', 'sta_a', 'available', false)],
        ocpiLocationId: 'LOC-1',
        countryCode: 'US',
        partyId: 'EVT',
        maintenance: { allAffected: true, affectedStationIds: new Set() },
      },
      '2.2.1',
    );
    expect(loc.evses?.[0]?.status).toBe('INOPERATIVE');
  });
});
