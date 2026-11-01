// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

// The entries of the site layout legend (shared by the 2D and 3D views): only
// what the view draws at this site (owner decision 2026-11-01). Station kinds
// (AC, DC) and power equipment show in 3D only, as only the 3D view draws
// them; the station states list the states a station of this site shows now
// plus the states every station can reach; the connection types list those
// the site's stations have.

import {
  depotLayout,
  energyAssetsOf,
  showsBatteries,
  showsSolar,
  siteTypeOf,
  type SiteLayoutSettings,
} from '@evtivity/lib/site-layout';
import {
  STATION_DISPLAY_STATES,
  stationDisplayState,
  type StationDisplayState,
} from '@/lib/station-display-state';
import type { LayoutStation } from './StationCard';
import { stationLayoutKindOf } from './site-layout-free';

/** A station's connection type as the layout reply names it. */
export type LayoutConnectionType = 'cellular' | 'wifi' | 'wired' | 'wifi_or_wired';

/** The connection types in legend order. */
export const LAYOUT_CONNECTION_TYPES: readonly LayoutConnectionType[] = [
  'cellular',
  'wifi',
  'wired',
  'wifi_or_wired',
];

/**
 * States every station can reach at any time, so the legend always explains
 * them: available, charging, faulted, unavailable (an operator or the station
 * turns it off) and offline. Maintenance, reserved and the unknown online
 * state show only when a station of the site shows them, reserved also while
 * the site takes reservations.
 */
const ALWAYS_POSSIBLE: ReadonlySet<StationDisplayState> = new Set([
  'faulted',
  'unavailable',
  'offline',
  'charging',
  'available',
]);

export interface LayoutLegend {
  ac: boolean;
  dc: boolean;
  battery: boolean;
  solar: boolean;
  building: boolean;
  carSpot: boolean;
  busBay: boolean;
  truckLane: boolean;
  street: boolean;
  /** The states to list, most severe first. */
  states: StationDisplayState[];
  /** The connection types to list, in legend order. */
  connections: LayoutConnectionType[];
  /** Whether a cellular station reported its signal (the signal bars entry). */
  signal: boolean;
}

export function layoutLegend(input: {
  stations: readonly LayoutStation[];
  settings: SiteLayoutSettings;
  show3d: boolean;
  /** Whether the site takes reservations (absent: unknown, listed only when shown). */
  reservationsEnabled?: boolean | undefined;
}): LayoutLegend {
  const { stations, settings, show3d } = input;
  const type = siteTypeOf(settings);
  const kinds = stations.map((s) => stationLayoutKindOf(s).charging);
  const assets = energyAssetsOf(settings);
  const depot = type === 'depot' ? depotLayout(settings) : null;
  const shown = new Set(stations.map((s) => stationDisplayState(s)));
  const states = STATION_DISPLAY_STATES.filter(
    (state) =>
      shown.has(state) ||
      (stations.length > 0 && ALWAYS_POSSIBLE.has(state)) ||
      (state === 'reserved' && input.reservationsEnabled === true && stations.length > 0),
  );
  const types = new Set(stations.map((s) => s.connectionType ?? null));
  return {
    ac: show3d && kinds.includes('ac'),
    dc: show3d && kinds.includes('dc'),
    battery: show3d && showsBatteries(settings) && assets.some((a) => a.type === 'battery'),
    solar: show3d && showsSolar(settings) && assets.some((a) => a.type === 'solar'),
    building: type === 'office_retail',
    carSpot: type === 'custom',
    busBay: depot != null && depot.busBays > 0,
    truckLane: depot != null && depot.truckLanes > 0,
    street: type === 'curbside',
    states,
    connections: LAYOUT_CONNECTION_TYPES.filter((t) => types.has(t)),
    signal: stations.some((s) => s.connectionType === 'cellular' && s.signal != null),
  };
}
