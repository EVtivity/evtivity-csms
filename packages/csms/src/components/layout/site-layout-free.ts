// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

// Custom site helpers shared by the 2D and 3D views, without three.js (the
// Layout tab imports them while the 3D chunk stays lazy): every station's
// free position and spots, the spot a two-spot station's car stands in, and
// the order station labels place in; the charger model of a spot type and
// the station counts a depot's defaults read.

import {
  layoutStationCountsOfKinds,
  layoutStationKind,
  type LayoutStationKind,
  firstFreePlacement,
  freeSpotCount,
  freeSpotRects,
  freeSpotTypeOf,
  SPLIT_SYSTEM,
  resolveFreeOverlaps,
  type FreePlacement,
  type FreeSpotType,
  type LayoutStationCounts,
} from '@evtivity/lib/site-layout';
import type { LayoutStation } from './StationCard';

/** A station of a custom site: where it stands and its spots (one per EVSE, at most two). */
export interface FreeStationPlace {
  placement: FreePlacement;
  spots: number;
}

/**
 * The free position and spots of every station of a custom site: its own
 * position, else one right of the others (the API sends one for each). Stored
 * positions whose spots overlap an earlier station's (a site saved before car
 * spots began 0.6 m in front of their charger instead of 0.9 m into it, so
 * the spots of two stations facing each other reach 1.5 m further) slide by
 * the shortest step that clears them, along the row or back along the spots
 * (`resolveFreeOverlaps` with `nearest`), so a saved site always shows a
 * valid layout; the layout Save stores what the view shows. Stations that
 * overlap nothing keep their hand-placed positions.
 */
export function freeStationPlaces(
  stations: readonly LayoutStation[],
): Map<string, FreeStationPlace> {
  const places = new Map<string, FreeStationPlace>();
  const stored = stations.flatMap((s) =>
    s.freePosition != null
      ? [{ key: s.id, placement: s.freePosition, spots: freeSpotCount(s.evses.length) }]
      : [],
  );
  const moved = resolveFreeOverlaps(stored, { nearest: true });
  for (const s of stored) {
    places.set(s.key, { placement: moved.get(s.key) ?? s.placement, spots: s.spots });
  }
  for (const s of stations) {
    if (places.has(s.id)) continue;
    const spots = freeSpotCount(s.evses.length);
    places.set(s.id, { placement: firstFreePlacement([...places.values()], spots), spots });
  }
  return places;
}

const IN_USE = new Set([
  'reserved',
  'occupied',
  'charging',
  'preparing',
  'suspendedev',
  'suspendedevse',
  'finishing',
]);

/**
 * The spot the vehicle, sign or cone of a station stands in (0 or 1, in EVSE
 * order): the spot of the EVSE that is charging (else reserved or in use),
 * else the first. A one-spot station: 0.
 */
export function freePropSpot(station: LayoutStation, spots: number): number {
  if (spots < 2) return 0;
  const sorted = [...station.evses].sort((a, b) => a.evseId - b.evseId);
  let active = sorted.findIndex((e) => e.connectors.some((c) => c.isPluggedIn));
  if (active < 0) {
    active = sorted.findIndex((e) => e.connectors.some((c) => IN_USE.has(c.status.toLowerCase())));
  }
  return active === 1 ? 1 : 0;
}

/**
 * Where the car, sign or cone of a two-spot station with car spots stands
 * across it, in its own x: the first spot on the left (-1.3 m), the second on
 * the right (1.3 m) (`freePropSpot`). A one-spot station: 0.
 */
export function freePropOffset(station: LayoutStation, spots: number): number {
  if (spots < 2) return 0;
  return freePropSpot(station, spots) === 1 ? 1.3 : -1.3;
}

/**
 * The charger model a station draws, from its spot type (a depot's bus bay or
 * truck lane, else car spots), its
 * charging kind and its connector types (OCPP ConnectorEnumStringType):
 * - `standard`: the AC pedestal or the DC charger (car spots, and an AC
 *   station on a large spot).
 * - `pantograph_down`: a depot mast whose pantograph comes down onto the
 *   contact rails on the bus roof (an `OppCharge` connector, SAE J3105-1).
 * - `pantograph_up`: a depot mast with a contact hood the bus roof pantograph
 *   rises to (a `Pan` connector, SAE J3105-2).
 * - `bus_dispenser`: a tall high-power dispenser with a cable boom (a plug-in
 *   DC station in a bus bay).
 * - `truck_mcs`: a heavy-duty megawatt dispenser with a cable management arm
 *   (a DC station on a truck pull-through lane).
 */
export type FreeChargerModel =
  | 'standard'
  | 'pantograph_down'
  | 'pantograph_up'
  | 'bus_dispenser'
  | 'truck_mcs';

export function freeChargerModel(
  spotType: FreeSpotType,
  kind: 'ac' | 'dc',
  connectorTypes: ReadonlyArray<string | null>,
): FreeChargerModel {
  if (spotType === 'bus_bay') {
    if (connectorTypes.includes('OppCharge')) return 'pantograph_down';
    if (connectorTypes.includes('Pan')) return 'pantograph_up';
    return kind === 'dc' ? 'bus_dispenser' : 'standard';
  }
  if (spotType === 'truck_pull_through') return kind === 'dc' ? 'truck_mcs' : 'standard';
  return 'standard';
}

/** The connector types of a layout station, in EVSE order. */
export function stationConnectorTypes(station: LayoutStation): Array<string | null> {
  return station.evses.flatMap((e) => e.connectors.map((c) => c.connectorType));
}

/** The layout kind of a station (AC or DC, its depot spot) from its connectors, as the API reads it. */
export function stationLayoutKindOf(station: Pick<LayoutStation, 'evses'>): LayoutStationKind {
  return layoutStationKind(
    station.evses.flatMap((e) => e.connectors),
    station.evses.length,
  );
}

/**
 * The stations of a site for the layout defaults: all of them, and how many
 * take a depot's truck lanes (an MCS connector) and bus bays (any other DC
 * station; an AC station takes neither), as the API counts them.
 */
export function layoutStationCountsOf(
  stations: ReadonlyArray<Pick<LayoutStation, 'evses'>>,
): LayoutStationCounts {
  return layoutStationCountsOfKinds(stations.map(stationLayoutKindOf));
}

/**
 * A custom site's DC split system (a DC station with three or more EVSEs,
 * `SPLIT_SYSTEM`): the x of a dispenser at the head of each of its car spots,
 * in its own frame, EVSE order; null for any other station or spot type.
 */
export function customSplitDispenserXs(
  station: Pick<LayoutStation, 'chargingKind' | 'evses'>,
  place: FreeStationPlace,
): number[] | null {
  if (station.chargingKind !== 'dc' || station.evses.length < SPLIT_SYSTEM.minDispensers) {
    return null;
  }
  if (freeSpotTypeOf(place.placement) !== 'car' || place.spots < SPLIT_SYSTEM.minDispensers) {
    return null;
  }
  return freeSpotRects(place.spots, 'car').map(
    (r) => Math.round(((r.minX + r.maxX) / 2) * 100) / 100 + 0,
  );
}
