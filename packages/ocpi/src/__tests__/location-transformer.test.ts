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
