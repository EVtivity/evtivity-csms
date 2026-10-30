// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

// The site layout demo as plain data (no database import), so the seed, its
// tests and the docs screenshot fixtures read one plan. Two sites with their
// own stations: Harbor Point Charging Hub on the default lot of 2 rows of 10
// spots with two transformers, and Lakeside Retail Park on a configured lot
// (3 rows of 6 wide spots, a 7 m lane, turned 90 degrees). Both are load
// managed with panels and circuits, so the 3D view draws the links.

import type { SiteLayoutSettings } from '@evtivity/lib/site-layout';

export interface LayoutDemoStation {
  id: string;
  stationId: string;
  kind: 'ac' | 'dc';
  col: number;
  row: number;
  /** The circuit the station hangs on. */
  circuitId: string;
  /** Cellular data plan (the 4G badge). */
  cellular?: boolean;
  /** No simulator: the station stays offline. */
  offline?: boolean;
  /** Covered by the demo maintenance event (the traffic cone). */
  maintenance?: boolean;
}

export interface LayoutDemoPanel {
  id: string;
  parentPanelId: string | null;
  name: string;
  breakerRatingAmps: number;
  voltageV: number;
  phases: number;
  maxContinuousKw: number;
  circuits: Array<{
    id: string;
    name: string;
    breakerRatingAmps: number;
    maxContinuousKw: number;
  }>;
}

export interface LayoutDemoSite {
  id: string;
  name: string;
  address: string;
  city: string;
  latitude: string;
  longitude: string;
  settings: SiteLayoutSettings;
  panels: LayoutDemoPanel[];
  stations: LayoutDemoStation[];
}

const dc = (n: number, col: number, row: number, circuitId: string, extra = {}) => ({
  id: `sta_demolayout${String(n).padStart(2, '0')}`,
  stationId: `CS-${String(3000 + n)}`,
  kind: 'dc' as const,
  col,
  row,
  circuitId,
  ...extra,
});
const ac = (n: number, col: number, row: number, circuitId: string, extra = {}) => ({
  ...dc(n, col, row, circuitId, extra),
  kind: 'ac' as const,
});

export interface LayoutDemoTerminal {
  providerDeviceId: string;
  label: string;
  vendor: string;
  model: string;
  serialNumber: string;
  firmwareVersion: string;
  stationId: string;
  /** OCPP EVSE number of the paired connector; null for the whole station. */
  evseNumber: number | null;
  online: boolean;
}

export const LAYOUT_DEMO: {
  sites: LayoutDemoSite[];
  maintenanceEventId: string;
  terminals: LayoutDemoTerminal[];
} = {
  sites: [
    {
      id: 'sit_demolayout01',
      name: 'Harbor Point Charging Hub',
      address: '200 Harbor Point Blvd',
      city: 'Albany',
      latitude: '42.646200',
      longitude: '-73.752800',
      settings: {
        spotsPerRow: 10,
        rows: 2,
        spotWidthM: 3.2,
        spotDepthM: 5.6,
        laneWidthM: 6,
        facingDeg: 0,
        transformers: [
          { id: 'tx-1', name: 'Utility Transformer', ratedKva: 2500, x: 36, z: 2.8 },
          { id: 'tx-2', name: 'Solar Carport Tie-In', ratedKva: 750, x: 9.6, z: -6 },
        ],
      },
      panels: [
        {
          id: 'pnl_demolayout01',
          parentPanelId: null,
          name: 'Main Switchboard',
          breakerRatingAmps: 800,
          voltageV: 480,
          phases: 3,
          maxContinuousKw: 532,
          circuits: [
            {
              id: 'cir_demolayout01',
              name: 'DC Bank',
              breakerRatingAmps: 600,
              maxContinuousKw: 400,
            },
          ],
        },
        {
          id: 'pnl_demolayout02',
          parentPanelId: 'pnl_demolayout01',
          name: 'Level 2 Panel',
          breakerRatingAmps: 225,
          voltageV: 208,
          phases: 3,
          maxContinuousKw: 64.8,
          circuits: [
            {
              id: 'cir_demolayout02',
              name: 'Level 2 Circuit',
              breakerRatingAmps: 200,
              maxContinuousKw: 57.6,
            },
          ],
        },
      ],
      stations: [
        dc(1, 0, 0, 'cir_demolayout01'),
        dc(2, 1, 0, 'cir_demolayout01', { cellular: true }),
        dc(3, 2, 0, 'cir_demolayout01'),
        dc(4, 3, 0, 'cir_demolayout01', { maintenance: true }),
        dc(5, 4, 0, 'cir_demolayout01'),
        dc(6, 5, 0, 'cir_demolayout01'),
        ac(7, 0, 1, 'cir_demolayout02'),
        ac(8, 1, 1, 'cir_demolayout02', { offline: true }),
        ac(9, 2, 1, 'cir_demolayout02'),
        ac(10, 3, 1, 'cir_demolayout02', { cellular: true }),
        ac(11, 4, 1, 'cir_demolayout02'),
        ac(12, 5, 1, 'cir_demolayout02'),
      ],
    },
    {
      id: 'sit_demolayout02',
      name: 'Lakeside Retail Park',
      address: '15 Lakeside Drive',
      city: 'Saratoga Springs',
      latitude: '43.071700',
      longitude: '-73.784400',
      settings: {
        spotsPerRow: 6,
        rows: 3,
        spotWidthM: 3.6,
        spotDepthM: 6,
        laneWidthM: 7,
        facingDeg: 90,
        transformers: [{ id: 'tx-1', name: 'Lakeside Substation', ratedKva: 1500, x: 26.1, z: 4 }],
      },
      panels: [
        {
          id: 'pnl_demolayout03',
          parentPanelId: null,
          name: 'Retail Panel',
          breakerRatingAmps: 400,
          voltageV: 480,
          phases: 3,
          maxContinuousKw: 266,
          circuits: [
            {
              id: 'cir_demolayout03',
              name: 'Fast Charge Circuit',
              breakerRatingAmps: 300,
              maxContinuousKw: 200,
            },
            {
              id: 'cir_demolayout04',
              name: 'Level 2 Circuit',
              breakerRatingAmps: 100,
              maxContinuousKw: 28.8,
            },
          ],
        },
      ],
      stations: [
        dc(13, 0, 0, 'cir_demolayout03'),
        dc(14, 1, 0, 'cir_demolayout03'),
        dc(15, 2, 0, 'cir_demolayout03'),
        dc(16, 3, 0, 'cir_demolayout03'),
        ac(17, 0, 1, 'cir_demolayout04'),
        ac(18, 1, 1, 'cir_demolayout04'),
        ac(19, 2, 1, 'cir_demolayout04'),
        ac(20, 3, 1, 'cir_demolayout04'),
      ],
    },
  ],
  /** The demo maintenance event of Harbor Point (one station). */
  maintenanceEventId: 'mev_demolayout01',
  /** Two more simulated card readers at Harbor Point: one online with a screen, one offline without. */
  terminals: [
    {
      providerDeviceId: 'sim_term_6',
      label: 'Hub DC Reader',
      vendor: 'ID TECH',
      model: 'VP6825',
      serialNumber: '6825SIM000006',
      firmwareVersion: '1.01.106',
      stationId: 'sta_demolayout06',
      evseNumber: 2,
      online: true,
    },
    {
      providerDeviceId: 'sim_term_7',
      label: 'Hub Pedestal Reader',
      vendor: 'ID TECH',
      model: 'VP7200',
      serialNumber: '7200SIM000007',
      firmwareVersion: '1.00.042',
      stationId: 'sta_demolayout11',
      evseNumber: null,
      online: false,
    },
  ],
};
