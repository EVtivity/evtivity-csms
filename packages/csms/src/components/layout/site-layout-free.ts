// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

// Custom site helpers shared by the 2D and 3D views, without three.js (the
// Layout tab imports them while the 3D chunk stays lazy): every station's
// free position and spots, the spot a two-spot station's car stands in, and
// the order station labels place in; the charger model of a spot type and
// the station counts a depot's defaults read.

import {
  layoutStationCountsOfKinds,
  type LayoutStationKind,
  firstFreePlacement,
  freeSpotRects,
  freeSpotTypeOf,
  SPLIT_SYSTEM,
  resolveFreeOverlaps,
  type FreePlacement,
  type FreeSpotType,
  type LayoutStationCounts,
} from '@evtivity/lib/site-layout';
import type { LayoutStation } from './StationCard';
import {
  expandUnitStations,
  layoutKindOfStation,
  layoutStationFreeSpots,
  layoutUnitChargers,
} from './site-layout-units';
import { usesFreePositions, type LayoutShape } from '@evtivity/lib/site-layout';

/**
 * The car spots of a station or a unit charger view on a custom site: a unit
 * charger its own (`expandUnitStations`), a station with units one per unit
 * EVSE (`stationFreeSpotCount`), else one per EVSE up to four.
 */
function freeSpotsOf(station: Pick<LayoutStation, 'evses' | 'units' | 'unitCharger'>): number {
  return station.unitCharger?.spots ?? layoutStationFreeSpots(station);
}

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
    s.freePosition != null ? [{ key: s.id, placement: s.freePosition, spots: freeSpotsOf(s) }] : [],
  );
  const moved = resolveFreeOverlaps(stored, { nearest: true });
  for (const s of stored) {
    places.set(s.key, { placement: moved.get(s.key) ?? s.placement, spots: s.spots });
  }
  for (const s of stations) {
    if (places.has(s.id)) continue;
    const spots = freeSpotsOf(s);
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
export function stationLayoutKindOf(
  station: Pick<LayoutStation, 'evses' | 'units'>,
): LayoutStationKind {
  return layoutKindOfStation(station);
}

/**
 * The stations of a site for the layout defaults: all of them, and how many
 * take a depot's truck lanes (an MCS connector) and bus bays (any other DC
 * station; an AC station takes neither), as the API counts them.
 */
export function layoutStationCountsOf(
  stations: ReadonlyArray<Pick<LayoutStation, 'evses' | 'units'>>,
): LayoutStationCounts {
  return layoutStationCountsOfKinds(stations.map(stationLayoutKindOf));
}

/**
 * A custom site's DC split system (a DC station with three or more EVSEs,
 * `SPLIT_SYSTEM`): the x of a dispenser at the head of each of its car spots,
 * in its own frame, EVSE order; null for any other station or spot type.
 */
export function customSplitDispenserXs(
  station: Pick<LayoutStation, 'chargingKind' | 'evses' | 'units' | 'unitCharger'>,
  place: FreeStationPlace,
): number[] | null {
  if (station.chargingKind !== 'dc' || station.evses.length < SPLIT_SYSTEM.minDispensers) {
    return null;
  }
  // A unit charger is never a split system, nor is a station with units.
  if (station.unitCharger != null || layoutUnitChargers(station) != null) return null;
  if (freeSpotTypeOf(place.placement) !== 'car' || place.spots < SPLIT_SYSTEM.minDispensers) {
    return null;
  }
  return freeSpotRects(place.spots, 'car').map(
    (r) => Math.round(((r.minX + r.maxX) / 2) * 100) / 100 + 0,
  );
}

/**
 * The stalls of a custom site's station with two or more car spots (one per
 * EVSE, EVSE order, the first on the left in its own frame, `freeSpotRects`):
 * each EVSE with a cable in gets its own vehicle in its own spot, as on a
 * parking lot (`stationStalls`). Null for one spot and for bus bays and truck
 * lanes (their large chargers place their one vehicle themselves).
 */
export function freeCarStalls(place: FreeStationPlace): Array<{ x: number; width: number }> | null {
  if (freeSpotTypeOf(place.placement) !== 'car' || place.spots < 2) return null;
  return freeSpotRects(place.spots, 'car').map((r) => ({
    x: Math.round(((r.minX + r.maxX) / 2) * 100) / 100 + 0,
    width: r.maxX - r.minX,
  }));
}

/**
 * The view stations of the site layout (`expandUnitStations`): a station with
 * units as one view station per unit charger. On a custom site each station
 * with units first takes its resolved free position (`freeStationPlaces`
 * over the stations), so its unit chargers stand together across its car
 * spots. A site without a station with units returns the list as given.
 */
export function layoutViewStations(
  stations: readonly LayoutStation[],
  settings: LayoutShape,
): readonly LayoutStation[] {
  if (!stations.some((s) => layoutUnitChargers(s) != null)) return stations;
  let base = stations;
  if (usesFreePositions(settings)) {
    const places = freeStationPlaces(stations);
    base = stations.map((s) =>
      layoutUnitChargers(s) == null
        ? s
        : { ...s, freePosition: places.get(s.id)?.placement ?? s.freePosition ?? null },
    );
  }
  return expandUnitStations(base, settings);
}
