// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

// Which connector of each EVSE of a layout charger has its handle in a vehicle
// and which vehicle stands in which stall, without three.js (site layout
// standards, the two charger cases, owner rule 2026-11-12):
// - Two EVSEs (a dual-port AC pedestal or wall box, a dual-outlet DC
//   dispenser, a two-EVSE unit): each EVSE that reports a cable gets its own
//   vehicle in its own stall, so two charge at once, each on its own cable.
// - One EVSE with several connectors (CCS1 and CHAdeMO, a triple outlet):
//   one vehicle at most, plugged through the connector that reports the
//   cable; that connector's holster stands empty and the others stay seated.
// A connector the model does not draw (past `CHARGER_PORT_LIMITS`, such as
// the second J1772 of an AC EVSE) plugs through the last drawn holster of its
// EVSE, so the drawn handle leaves its holster instead of a second handle
// appearing at the car.

import { CHARGER_PORT_LIMITS, drawnConnectorCounts } from '@evtivity/lib/site-layout';

/** One EVSE of a layout charger, EVSE order: its connectors' cable state. */
export interface PlugEvse {
  connectors: ReadonlyArray<{ isPluggedIn: boolean }>;
}

/**
 * The connectors the charger model draws on each EVSE, EVSE order: a split
 * system's satellites (`satellites` true) carry at most
 * `CHARGER_PORT_LIMITS.dc.satelliteConnectors` each, every EVSE its own
 * satellite; one charger unit draws `drawnConnectorCounts`.
 */
export function drawnEvseConnectors(
  kind: 'ac' | 'dc',
  evses: readonly PlugEvse[],
  satellites: boolean,
): number[] {
  const perEvse = evses.map((e) => Math.max(1, e.connectors.length));
  if (satellites) {
    return perEvse.map((n) =>
      Math.min(CHARGER_PORT_LIMITS.dc.satelliteConnectors, drawnConnectorCounts('dc', [n])[0] ?? 1),
    );
  }
  return drawnConnectorCounts(kind, perEvse);
}

export interface StationPlugs<Car> {
  /** Per drawn EVSE: a connector reports a cable in (an undrawn EVSE folded into the last). */
  pluggedIn: boolean[];
  /**
   * The EVSE of the station's session vehicle: its session's EVSE (`homeEvse`), else the
   * first with a cable in, else the first.
   */
  firstPlugged: number;
  /** Per EVSE: the drawn holster (connector index) its vehicle is plugged through. */
  plugged: number[];
  /**
   * A charger serving two or more stalls (`stallCount`), while a vehicle shows:
   * the vehicle of each stall, EVSE order (null: an empty stall). Absent: one vehicle.
   */
  stallCars?: Array<Car | null>;
}

/**
 * The plugs and vehicles of one layout charger. `evses` in EVSE order,
 * `drawn` the connectors drawn per EVSE (`drawnEvseConnectors`), `stallCount`
 * the stalls it serves (one per EVSE; 1 or 0: one vehicle), `homeEvse` the EVSE
 * of the station's session (-1 unknown), `carShown` the
 * station shows a vehicle (`stationProp` is `car`), `carOf` the vehicle of
 * EVSE i's stall.
 */
export function stationPlugs<Car>(input: {
  evses: readonly PlugEvse[];
  drawn: readonly number[];
  stallCount: number;
  carShown: boolean;
  /** The EVSE index (EVSE order) the station's session runs on; -1 or absent when unknown. */
  homeEvse?: number;
  carOf: (evse: number, firstPlugged: number) => Car;
}): StationPlugs<Car> {
  // An EVSE past the drawn ones (a third AC EVSE) plugs through the last drawn EVSE while
  // that one has no cable in, so its vehicle and empty holster still show.
  const last = Math.max(1, input.drawn.length) - 1;
  const evses = input.evses.slice(0, last + 1).map((e) => e.connectors);
  for (const extra of input.evses.slice(last + 1)) {
    if (
      !(evses[last] ?? []).some((c) => c.isPluggedIn) &&
      extra.connectors.some((c) => c.isPluggedIn)
    ) {
      evses[last] = extra.connectors;
    }
  }
  const pluggedIn = evses.map((cs) => cs.some((c) => c.isPluggedIn));
  // The session's own EVSE when the station names it (owner decision 2026-11-12), an
  // undrawn EVSE on the last drawn one; else the first with a cable in.
  const home = input.homeEvse ?? -1;
  const firstPlugged =
    home >= 0 ? Math.min(home, pluggedIn.length - 1) : Math.max(0, pluggedIn.indexOf(true));
  const plugged = evses.map((cs, i) => {
    const at = Math.max(
      0,
      cs.findIndex((c) => c.isPluggedIn),
    );
    const drawn = input.drawn[i];
    return drawn == null ? 0 : Math.min(at, Math.max(1, drawn) - 1);
  });
  if (input.stallCount < 2 || !input.carShown) return { pluggedIn, firstPlugged, plugged };
  const stallCars = Array.from({ length: input.stallCount }, (_, i) =>
    i === firstPlugged || pluggedIn[i] === true ? input.carOf(i, firstPlugged) : null,
  );
  return { pluggedIn, firstPlugged, plugged, stallCars };
}

/**
 * The EVSE index (EVSE order) of a station's session: the EVSE whose own
 * session it is, else the EVSE the session names (`evseId`, an OCPP number);
 * -1 without a session or when the station has not named its EVSE.
 */
export function sessionEvseIndex(
  session: { id: string; evseId?: number | null | undefined } | null | undefined,
  evses: ReadonlyArray<{ evseId: number; session?: { id: string } | null | undefined }>,
): number {
  if (session == null) return -1;
  const own = evses.findIndex((e) => e.session?.id === session.id);
  if (own >= 0) return own;
  if (session.evseId == null) return -1;
  return evses.findIndex((e) => e.evseId === session.evseId);
}
