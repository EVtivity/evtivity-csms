// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

// Stations with units on the site layout, without three.js (the Layout tab
// and the dashboard widget import it). A unit is one physical charger box
// under one OCPP station, such as the ABL eM4 master and its extenders
// (GitHub discussion 59): the 3D and 2D views draw each unit as its own
// charger (owner decision D5, 2026-11-11), by its own kind and EVSE count, in
// one contiguous run of spots from the station's one stored slot (the split
// system rule, `stationSpanCount` in @evtivity/lib/site-layout).
//
// `expandUnitStations` turns each station with units into one view station
// per unit charger: the first keeps the station's id, the others are
// `<station id>#u<n>` (n from 2, the split dispenser id pattern), so the
// popup, the hover label, the cars, the cable runs and the 2D cards work per
// unit through the per-station code paths. A station without units comes
// back as the same object (owner decision D3: unchanged).

import {
  stationFreeSpotCount,
  stationUnitChargers,
  unitChargerKinds,
  unitChargerSpans,
  bayToPosition,
  freeSpotRects,
  freeToSite,
  layoutStationKind,
  positionToBay,
  usesFreePositions,
  type LayoutShape,
  type LayoutStationKind,
  type UnitCharger,
} from '@evtivity/lib/site-layout';
import type { TFunction } from 'i18next';
import type { LayoutSession, LayoutStation } from './StationCard';
import type { LayoutTerminal } from './layout-terminals';

const UNIT_ID_SEPARATOR = '#u';

/** The view id of a station's unit charger: the station id for the first, `<id>#u<n>` for the others. */
export function unitChargerViewId(stationUuid: string, index: number): string {
  return index === 0 ? stationUuid : `${stationUuid}${UNIT_ID_SEPARATOR}${String(index + 1)}`;
}

/** The station (internal id) a layout view id belongs to: the id itself for a station's own id. */
export function layoutStationIdOf(viewId: string): string {
  const at = viewId.indexOf(UNIT_ID_SEPARATOR);
  return at < 0 ? viewId : viewId.slice(0, at);
}

/** The unit chargers of a layout station (null without units, `stationUnitChargers`). */
export function layoutUnitChargers(
  station: Pick<LayoutStation, 'units' | 'evses'>,
): UnitCharger[] | null {
  // In-service EVSEs with a connector only, as the server's placement counts
  // them (`readStationLayoutKinds`): a retired EVSE draws on no unit charger.
  return stationUnitChargers({
    units: station.units ?? [],
    evses: station.evses.filter((e) => e.retired !== true && e.connectors.length > 0),
  });
}

/**
 * The layout kind of a station as the API reads it (`readStationLayoutKinds`):
 * AC or DC, its depot spot, its EVSEs and, for a station with units, the kind
 * of each unit charger.
 */
export function layoutKindOfStation(
  station: Pick<LayoutStation, 'units' | 'evses'>,
): LayoutStationKind {
  return layoutStationKind(
    station.evses.flatMap((e) => e.connectors),
    station.evses.length,
    unitChargerKinds(layoutUnitChargers(station)),
  );
}

/** The car spots a station gets on a custom site (`stationFreeSpotCount`). */
export function layoutStationFreeSpots(station: Pick<LayoutStation, 'units' | 'evses'>): number {
  return stationFreeSpotCount(station.evses.length, layoutKindOfStation(station));
}

// Connector statuses of a plug in use (the API's station summary,
// buildDerivedStatusSubquery IN_USE_STATUSES, in the layout's lowercase spelling).
const IN_USE = new Set([
  'occupied',
  'charging',
  'preparing',
  'ev_connected',
  'suspended_ev',
  'suspended_evse',
  'idle',
  'discharging',
]);

/**
 * The status a unit charger shows. The station's own state (a disable,
 * firmware, or a station-reported fault or outage: a status reason other than
 * a connector fault) shows on every unit, because one OCPP connection serves
 * them all (owner decision O4 A); offline and maintenance come from the
 * station's own fields. Otherwise the station connector summary rule, over
 * the unit's connectors only: charging, reserved, faulted, unknown (none),
 * available (all), else unavailable.
 */
export function unitChargerStatus(
  station: Pick<LayoutStation, 'status' | 'statusReason'>,
  evses: LayoutStation['evses'],
): string {
  if (station.statusReason != null && station.statusReason !== 'connector_faulted') {
    return station.status;
  }
  const statuses = evses.flatMap((e) => e.connectors.map((c) => c.status.toLowerCase()));
  if (statuses.some((s) => IN_USE.has(s))) return 'charging';
  if (statuses.includes('reserved')) return 'reserved';
  if (statuses.includes('faulted')) return 'faulted';
  if (statuses.length === 0) return 'unknown';
  if (statuses.every((s) => s === 'available')) return 'available';
  return 'unavailable';
}

/**
 * The session a unit charger shows: the session of its first EVSE that has
 * one; the station's own session (with its departure) when it is that one.
 */
function unitSession(
  station: Pick<LayoutStation, 'session'>,
  evses: LayoutStation['evses'],
): LayoutSession | null {
  const own = evses.find((e) => e.session != null)?.session ?? null;
  if (own == null) return null;
  if (station.session != null && station.session.id === own.id) return station.session;
  return { ...own, vehicle: own.vehicle ?? null };
}

/**
 * Where each unit charger of a custom site's station stands: across the
 * station's row of car spots (`freeSpotRects`, one spot per unit EVSE, two
 * at most per charger), at the middle of its own spots, the station's turn.
 */
function unitFreePlacement(
  station: LayoutStation,
  chargers: readonly UnitCharger[],
  index: number,
): { placement: LayoutStation['freePosition']; spots: number; offsetX: number } {
  const parent = station.freePosition;
  const spotsOf = (c: UnitCharger): number => Math.max(1, Math.min(2, c.ports));
  const charger = chargers[index] ?? chargers[0];
  const spots = charger == null ? 1 : spotsOf(charger);
  if (parent == null) return { placement: null, spots, offsetX: 0 };
  const rects = freeSpotRects(layoutStationFreeSpots(station), 'car');
  const first = chargers.slice(0, index).reduce((n, c) => n + spotsOf(c), 0);
  const a = rects[first];
  const b = rects[first + spots - 1];
  if (a == null || b == null) return { placement: parent, spots, offsetX: 0 };
  const x = Math.round(((a.minX + b.maxX) / 2) * 100) / 100 + 0;
  const at = freeToSite(parent, x, 0);
  return { placement: { ...parent, x: at.x, z: at.z }, spots, offsetX: x };
}

/**
 * The free position of a station whose unit charger now stands at
 * `placement` (a custom site move of one unit moves the whole station).
 */
export function stationPlacementOfUnit(
  unit: Pick<NonNullable<LayoutStation['unitCharger']>, 'freeOffsetX'>,
  placement: NonNullable<LayoutStation['freePosition']>,
): NonNullable<LayoutStation['freePosition']> {
  const at = freeToSite(placement, -unit.freeOffsetX, 0);
  return { ...placement, x: at.x, z: at.z };
}

/**
 * The view stations of the layout: a station without units as it is, and a
 * station with units as one view station per unit charger (`UnitCharger`),
 * each with its own EVSEs, status (`unitChargerStatus`), session and, on a
 * parking lot, an office or retail row, a depot (its own bus bay or truck
 * lane) or a street (its own curb post), its own slot in the station's run
 * (`unitChargerSpans`, owner decision 2026-11-12), on a custom site its own
 * place across the station's car spots. The reservation
 * window shows on the unit whose connector is reserved, else on the first.
 */
export function expandUnitStations(
  stations: readonly LayoutStation[],
  settings: LayoutShape,
): LayoutStation[] {
  const custom = usesFreePositions(settings);
  return stations.flatMap((station) => {
    const chargers = layoutUnitChargers(station);
    if (chargers == null) return [station];
    const spans = unitChargerSpans(chargers, settings);
    const bay = positionToBay({ x: station.positionX, y: station.positionY });
    const unitOf = new Map((station.units ?? []).map((u) => [u.id, u]));
    // The box number: the unit's place in the station's unit order (the API sends them in it).
    const numberOf = new Map((station.units ?? []).map((u, i) => [u.id, i + 1]));
    // The station's session when no EVSE session names it (a session without a
    // connector): it shows on the first unit with a plug in, else the first.
    const orphan =
      station.session != null &&
      !station.evses.some((e) => e.session != null && e.session.id === station.session?.id);
    const pluggedIndex = Math.max(
      0,
      chargers.findIndex((c) =>
        station.evses.some(
          (e) => c.evseIds.includes(e.evseId) && e.connectors.some((conn) => conn.isPluggedIn),
        ),
      ),
    );
    const reservedIndex = chargers.findIndex((c) =>
      station.evses.some(
        (e) =>
          c.evseIds.includes(e.evseId) &&
          e.connectors.some((conn) => conn.status.toLowerCase() === 'reserved'),
      ),
    );
    return chargers.map((charger, i): LayoutStation => {
      const evses = station.evses.filter((e) => charger.evseIds.includes(e.evseId));
      const span = spans[i] ?? { offset: 0, spots: 1 };
      const slot = bayToPosition({ col: bay.col + span.offset, row: bay.row });
      const free = custom ? unitFreePlacement(station, chargers, i) : null;
      const board =
        charger.unitId == null
          ? (station.boardPosition ?? null)
          : (unitOf.get(charger.unitId)?.boardPosition ?? null);
      return {
        ...station,
        id: unitChargerViewId(station.id, i),
        // Each unit draws its own kind (an AC box of a station whose units mix AC and DC
        // stays an AC pedestal); the station is placed by its own kind (`stationKind`).
        chargingKind: charger.charging,
        status: unitChargerStatus(station, evses),
        statusReason:
          station.statusReason != null && station.statusReason !== 'connector_faulted'
            ? station.statusReason
            : null,
        evses,
        session:
          unitSession(station, evses) ??
          (orphan && i === pluggedIndex ? (station.session ?? null) : null),
        reservation: i === Math.max(0, reservedIndex) ? (station.reservation ?? null) : null,
        positionX: slot.x,
        positionY: slot.y,
        freePosition: free?.placement ?? null,
        boardPosition: board,
        units: [],
        unitCharger: {
          stationUuid: station.id,
          unitId: charger.unitId,
          name: charger.name,
          index: i,
          offset: span.offset,
          spots: custom ? (free?.spots ?? 1) : span.spots,
          freeOffsetX: free?.offsetX ?? 0,
          stationKind: station.chargingKind,
          number: charger.unitId == null ? null : (numberOf.get(charger.unitId) ?? null),
        },
      };
    });
  });
}

/**
 * The name a view station shows (hover label, popup, list, 2D card):
 * "<station>, <unit>" for a unit charger, else the station's OCPP id (also
 * for the charger of the EVSEs without a unit, which the station names).
 */
export function layoutChargerName(
  station: Pick<LayoutStation, 'stationId' | 'unitCharger'>,
  t: TFunction,
): string {
  const name = station.unitCharger?.name;
  if (name == null) return station.stationId;
  return t('layout.units.chargerName', { station: station.stationId, unit: name });
}

/**
 * The payment terminals each view station shows: a station's own; a unit
 * charger those paired to one of its EVSEs, and a terminal paired to the
 * whole station on the station's first charger only (a reader is paired to
 * the dispenser it stands on, site-layout-standards.md).
 */
export function viewStationTerminals(
  stations: readonly LayoutStation[],
  terminals: ReadonlyMap<string, readonly LayoutTerminal[]>,
): Map<string, LayoutTerminal[]> {
  const out = new Map<string, LayoutTerminal[]>();
  for (const s of stations) {
    const unit = s.unitCharger;
    const own = terminals.get(unit?.stationUuid ?? s.id) ?? [];
    if (unit == null) {
      if (own.length > 0) out.set(s.id, [...own]);
      continue;
    }
    const evseIds = new Set(s.evses.map((e) => e.evseId));
    const list = own.filter((term) =>
      term.evseNumber == null ? unit.index === 0 : evseIds.has(term.evseNumber),
    );
    if (list.length > 0) out.set(s.id, list);
  }
  return out;
}

/**
 * The EVSE number a reader side follows on a view station: for a unit
 * charger the place of the EVSE within the unit (1 for its first EVSE, 2 for
 * its second), so the reader stands at that port; else the number as given.
 */
export function chargerEvseNumber(
  station: Pick<LayoutStation, 'unitCharger' | 'evses'>,
  evseNumber: number | null,
): number | null {
  if (station.unitCharger == null || evseNumber == null) return evseNumber;
  const order = [...station.evses].map((e) => e.evseId).sort((a, b) => a - b);
  const at = order.indexOf(evseNumber);
  return at < 0 ? null : at + 1;
}

/**
 * The partner column of a two-spot unit charger: the next spot of its own
 * run (the station's run decides the pair, not the lot's column parity,
 * `spotPairPartner`); null for every other view station.
 */
export function unitPartnerCol(
  station: Pick<LayoutStation, 'unitCharger' | 'positionX' | 'positionY'>,
): number | null {
  const unit = station.unitCharger;
  if (unit == null || unit.spots < 2) return null;
  return positionToBay({ x: station.positionX, y: station.positionY }).col + 1;
}
