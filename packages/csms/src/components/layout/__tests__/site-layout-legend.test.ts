// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { describe, it, expect } from 'vitest';
import {
  NO_POWER_EQUIPMENT,
  effectiveLayoutSettings,
  placePowerEquipment,
  type PlacedLayoutSettings,
} from '@evtivity/lib/site-layout';
import { layoutLegend } from '../site-layout-legend';
import type { LayoutStation } from '../StationCard';

function station(
  id: string,
  connectorType: string,
  maxPowerKw: number,
  overrides: Partial<LayoutStation> = {},
): LayoutStation {
  return {
    id,
    stationId: id,
    model: null,
    status: 'available',
    statusReason: null,
    isOnline: true,
    securityProfile: 1,
    positionX: 20,
    positionY: 20,
    placed: true,
    chargingKind: maxPowerKw > 22 ? 'dc' : 'ac',
    cellular: false,
    inMaintenance: false,
    displayMessage: null,
    evses: [
      {
        evseId: 1,
        status: 'available',
        connectors: [
          {
            connectorId: 1,
            connectorType,
            maxPowerKw,
            status: 'available',
            isPluggedIn: false,
            energyDeliveredWh: null,
          },
        ],
      },
    ],
    ...overrides,
  };
}

const lot = placePowerEquipment(effectiveLayoutSettings(null), NO_POWER_EQUIPMENT);
const depot: PlacedLayoutSettings = {
  ...lot,
  siteType: 'depot',
  busBays: 3,
  truckLanes: 0,
};

describe('layout legend', () => {
  it('lists only the station kinds the site has, in 3D only', () => {
    const dcOnly = [station('a', 'CCS1', 150), station('b', 'CCS1', 150)];
    const legend = layoutLegend({ stations: dcOnly, settings: depot, show3d: true });
    // A depot without AC lists no AC pedestal.
    expect(legend.ac).toBe(false);
    expect(legend.dc).toBe(true);
    // Bus bays, but no truck lanes at this depot.
    expect(legend.busBay).toBe(true);
    expect(legend.truckLane).toBe(false);
    expect(layoutLegend({ stations: dcOnly, settings: depot, show3d: false }).dc).toBe(false);
    // The 2D view draws no ground marks, so it lists none (owner rule 2026-11-02).
    expect(layoutLegend({ stations: dcOnly, settings: depot, show3d: false })).toMatchObject({
      busBay: false,
      truckLane: false,
      carSpot: false,
      building: false,
      street: false,
    });
    const mixed = [station('a', 'Type1', 7), station('b', 'CCS1', 150)];
    expect(layoutLegend({ stations: mixed, settings: lot, show3d: true })).toMatchObject({
      ac: true,
      dc: true,
      busBay: false,
      carSpot: false,
      building: false,
      battery: false,
      solar: false,
    });
  });

  it('lists the states every station can reach and the others only when shown', () => {
    const plain = layoutLegend({
      stations: [station('a', 'CCS1', 150)],
      settings: lot,
      show3d: true,
    });
    expect(plain.states).toEqual(['faulted', 'unavailable', 'offline', 'charging', 'available']);
    const shown = layoutLegend({
      stations: [
        station('a', 'CCS1', 150, { inMaintenance: true, status: 'unavailable' }),
        station('b', 'CCS1', 150, { status: 'reserved' }),
      ],
      settings: lot,
      show3d: true,
    });
    // Maintenance once (its window's Unavailable shows as Maintenance), reserved once.
    expect(shown.states).toEqual([
      'faulted',
      'maintenance',
      'unavailable',
      'offline',
      'reserved',
      'charging',
      'available',
    ]);
    // A site taking reservations lists Reserved before any station is reserved.
    expect(
      layoutLegend({
        stations: [station('a', 'CCS1', 150)],
        settings: lot,
        show3d: false,
        reservationsEnabled: true,
      }).states,
    ).toContain('reserved');
    expect(layoutLegend({ stations: [], settings: lot, show3d: true }).states).toEqual([]);
  });

  it('lists Cellular, Wi-Fi and Wired apart, only those present', () => {
    const legend = layoutLegend({
      stations: [
        station('a', 'CCS1', 150, { connectionType: 'wired' }),
        station('b', 'CCS1', 150, { connectionType: 'wifi' }),
        station('c', 'CCS1', 150, { connectionType: 'wired' }),
      ],
      settings: lot,
      show3d: true,
    });
    expect(legend.connections).toEqual(['wifi', 'wired']);
    expect(legend.signal).toBe(false);
    const cellular = layoutLegend({
      stations: [
        station('a', 'CCS1', 150, { connectionType: 'cellular', signal: { bars: 3, dbm: -80 } }),
        station('b', 'CCS1', 150, { connectionType: 'wifi_or_wired' }),
      ],
      settings: lot,
      show3d: true,
    });
    expect(cellular.connections).toEqual(['cellular', 'wifi_or_wired']);
    expect(cellular.signal).toBe(true);
  });
});

describe('layout legend equipment', () => {
  it('lists a battery and solar from the site equipment rows, without a stored position', () => {
    const withAssets = placePowerEquipment(effectiveLayoutSettings(null), {
      transformers: [],
      energyAssets: [
        { id: 'ena_b', type: 'battery', name: 'B', capacityKwh: null, peakKwp: null },
        { id: 'ena_s', type: 'solar', name: 'S', capacityKwh: null, peakKwp: null },
      ],
    });
    expect(
      layoutLegend({ stations: [station('a', 'CCS1', 150)], settings: withAssets, show3d: true }),
    ).toMatchObject({ battery: true, solar: true });
  });
});
