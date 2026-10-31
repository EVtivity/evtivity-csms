// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

// The site layout demo as plain data (no database import), so the seed, its
// tests and the docs screenshot fixtures read one plan. Two sites, each with
// one kind of charger, as on real sites: Harbor Point Charging Hub, a parking
// lot (an outdoor hub of DC fast chargers, 2 rows of 6 spots, two transformers
// and a battery on the grass, a solar carport over the back row, one faulted
// station without a simulator), and Lakeside Retail Park, an office or retail site (one row of
// 12 spots along the building front with AC wall boxes, turned 90 degrees).
// Both are load managed with panels, a sub-panel and circuits, so the 3D view
// draws the panels and their links.
//
// Earlier releases of the demo mixed DC and AC chargers on both sites. A rerun
// moves the stations of the earlier plan (`movedFrom`), renames its panels and
// circuits (`renamedFrom`) and replaces the layout settings it seeded
// (`LAYOUT_DEMO_PREVIOUS_SETTINGS`), each only while the row still holds what
// that plan wrote, so an operator's own change stays.

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
  /** No simulator, a faulted connector and an open AI insight on it (the faulted state). */
  faulted?: boolean;
  /** Where the earlier plan seeded the station (a rerun moves it from there). */
  movedFrom?: { siteId: string; circuitId: string };
}

export interface LayoutDemoPanel {
  id: string;
  parentPanelId: string | null;
  name: string;
  breakerRatingAmps: number;
  voltageV: number;
  phases: number;
  maxContinuousKw: number;
  /** The name the earlier plan gave the panel (a rerun renames it). */
  renamedFrom?: string;
  circuits: LayoutDemoCircuit[];
}

export interface LayoutDemoCircuit {
  id: string;
  name: string;
  breakerRatingAmps: number;
  maxContinuousKw: number;
  /** The circuit as the earlier plan seeded it (a rerun renames it and moves it to this panel). */
  renamedFrom?: { name: string; panelId: string };
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

type StationExtra = Pick<
  LayoutDemoStation,
  'cellular' | 'offline' | 'maintenance' | 'faulted' | 'movedFrom'
>;

const dc = (
  n: number,
  col: number,
  row: number,
  circuitId: string,
  extra: StationExtra = {},
): LayoutDemoStation => ({
  id: `sta_demolayout${String(n).padStart(2, '0')}`,
  stationId: `CS-${String(3000 + n)}`,
  kind: 'dc' as const,
  col,
  row,
  circuitId,
  ...extra,
});
const ac = (
  n: number,
  col: number,
  row: number,
  circuitId: string,
  extra: StationExtra = {},
): LayoutDemoStation => ({
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
  /** The station the earlier plan paired the reader to (a rerun pairs it again here). */
  pairedBefore?: string;
}

const HARBOR = 'sit_demolayout01';
const LAKESIDE = 'sit_demolayout02';

export const LAYOUT_DEMO: {
  sites: LayoutDemoSite[];
  maintenanceEventId: string;
  faultInsightId: string;
  terminals: LayoutDemoTerminal[];
} = {
  sites: [
    {
      id: HARBOR,
      name: 'Harbor Point Charging Hub',
      address: '200 Harbor Point Blvd',
      city: 'Albany',
      latitude: '42.646200',
      longitude: '-73.752800',
      settings: {
        siteType: 'parking_lot',
        spotsPerRow: 6,
        rows: 2,
        spotWidthM: 3.4,
        spotDepthM: 5.8,
        laneWidthM: 7,
        facingDeg: 0,
        transformers: [
          { id: 'tx-1', name: 'Utility Transformer', ratedKva: 2500, x: -14, z: 2.5 },
          { id: 'tx-2', name: 'Solar Carport Tie-In', ratedKva: 750, x: -14, z: 16 },
        ],
        energyAssets: [
          { id: 'bat-1', type: 'battery', name: 'Battery Storage', capacityKwh: 1000, x: 25, z: 4 },
          { id: 'pv-1', type: 'solar', name: 'Solar Carport', capacityKwp: 180, row: 1 },
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
              name: 'DC Bank A',
              breakerRatingAmps: 600,
              maxContinuousKw: 400,
              renamedFrom: { name: 'DC Bank', panelId: 'pnl_demolayout01' },
            },
          ],
        },
        {
          id: 'pnl_demolayout02',
          parentPanelId: 'pnl_demolayout01',
          name: 'DC Bank B Switchboard',
          renamedFrom: 'Level 2 Panel',
          breakerRatingAmps: 400,
          voltageV: 480,
          phases: 3,
          maxContinuousKw: 266,
          circuits: [
            {
              id: 'cir_demolayout02',
              name: 'DC Bank B',
              breakerRatingAmps: 300,
              maxContinuousKw: 200,
              renamedFrom: { name: 'Level 2 Circuit', panelId: 'pnl_demolayout02' },
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
        dc(13, 1, 1, 'cir_demolayout02', {
          movedFrom: { siteId: LAKESIDE, circuitId: 'cir_demolayout03' },
        }),
        dc(14, 2, 1, 'cir_demolayout02', {
          movedFrom: { siteId: LAKESIDE, circuitId: 'cir_demolayout03' },
        }),
        dc(15, 3, 1, 'cir_demolayout02', {
          movedFrom: { siteId: LAKESIDE, circuitId: 'cir_demolayout03' },
        }),
        dc(16, 4, 1, 'cir_demolayout02', {
          movedFrom: { siteId: LAKESIDE, circuitId: 'cir_demolayout03' },
        }),
        dc(21, 0, 1, 'cir_demolayout02', { offline: true, faulted: true }),
      ],
    },
    {
      id: LAKESIDE,
      name: 'Lakeside Retail Park',
      address: '15 Lakeside Drive',
      city: 'Saratoga Springs',
      latitude: '43.071700',
      longitude: '-73.784400',
      settings: {
        siteType: 'office_retail',
        spotsPerRow: 12,
        rows: 1,
        spotWidthM: 2.8,
        spotDepthM: 5.5,
        laneWidthM: 6,
        facingDeg: 90,
        transformers: [],
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
              name: 'Level 2 Circuit A',
              breakerRatingAmps: 200,
              maxContinuousKw: 57.6,
              renamedFrom: { name: 'Fast Charge Circuit', panelId: 'pnl_demolayout03' },
            },
          ],
        },
        {
          id: 'pnl_demolayout04',
          parentPanelId: 'pnl_demolayout03',
          name: 'Level 2 Sub-Panel',
          breakerRatingAmps: 225,
          voltageV: 208,
          phases: 3,
          maxContinuousKw: 64.8,
          circuits: [
            {
              id: 'cir_demolayout04',
              name: 'Level 2 Circuit B',
              breakerRatingAmps: 100,
              maxContinuousKw: 28.8,
              renamedFrom: { name: 'Level 2 Circuit', panelId: 'pnl_demolayout03' },
            },
          ],
        },
      ],
      stations: [
        ac(7, 0, 0, 'cir_demolayout03', {
          movedFrom: { siteId: HARBOR, circuitId: 'cir_demolayout02' },
        }),
        ac(8, 1, 0, 'cir_demolayout03', {
          offline: true,
          movedFrom: { siteId: HARBOR, circuitId: 'cir_demolayout02' },
        }),
        ac(9, 2, 0, 'cir_demolayout03', {
          movedFrom: { siteId: HARBOR, circuitId: 'cir_demolayout02' },
        }),
        ac(10, 3, 0, 'cir_demolayout03', {
          cellular: true,
          movedFrom: { siteId: HARBOR, circuitId: 'cir_demolayout02' },
        }),
        ac(11, 4, 0, 'cir_demolayout03', {
          movedFrom: { siteId: HARBOR, circuitId: 'cir_demolayout02' },
        }),
        ac(12, 5, 0, 'cir_demolayout03', {
          movedFrom: { siteId: HARBOR, circuitId: 'cir_demolayout02' },
        }),
        ac(17, 6, 0, 'cir_demolayout04'),
        ac(18, 7, 0, 'cir_demolayout04'),
        ac(19, 8, 0, 'cir_demolayout04'),
        ac(20, 9, 0, 'cir_demolayout04'),
      ],
    },
  ],
  /** The demo maintenance event of Harbor Point (one station). */
  maintenanceEventId: 'mev_demolayout01',
  /** The open AI insight on the faulted station (seed-ai-insights.ts `seedStationFaultInsight`). */
  faultInsightId: 'ain_aidemo000020',
  /** Two more simulated card readers on DC chargers at Harbor Point: one online with a screen, one offline without. */
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
      label: 'Hub Lane Reader',
      vendor: 'ID TECH',
      model: 'VP7200',
      serialNumber: '7200SIM000007',
      firmwareVersion: '1.00.042',
      stationId: 'sta_demolayout14',
      evseNumber: null,
      online: false,
      pairedBefore: 'sta_demolayout11',
    },
  ],
};

/**
 * The layout settings earlier plans seeded, by site, oldest first: a rerun
 * replaces stored settings only while they are still one of these (an
 * operator's edit stays). Harbor Point's second entry is the plan before the
 * battery and the solar canopy.
 */
export const LAYOUT_DEMO_PREVIOUS_SETTINGS: Readonly<Record<string, SiteLayoutSettings[]>> = {
  [HARBOR]: [
    {
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
    {
      siteType: 'parking_lot',
      spotsPerRow: 6,
      rows: 2,
      spotWidthM: 3.4,
      spotDepthM: 5.8,
      laneWidthM: 7,
      facingDeg: 0,
      transformers: [
        { id: 'tx-1', name: 'Utility Transformer', ratedKva: 2500, x: -14, z: 2.5 },
        { id: 'tx-2', name: 'Solar Carport Tie-In', ratedKva: 750, x: -14, z: 16 },
      ],
    },
  ],
  [LAKESIDE]: [
    {
      spotsPerRow: 6,
      rows: 3,
      spotWidthM: 3.6,
      spotDepthM: 6,
      laneWidthM: 7,
      facingDeg: 90,
      transformers: [{ id: 'tx-1', name: 'Lakeside Substation', ratedKva: 1500, x: 26.1, z: 4 }],
    },
  ],
};
