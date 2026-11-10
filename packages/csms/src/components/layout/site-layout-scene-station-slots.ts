// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

// Which connector of a scene station hangs in which holster, and where its car stands.

import { SPLIT_SYSTEM } from '@evtivity/lib/site-layout';
import { parksBackedIn, type CarPort, type Point3 } from './site-layout-cable';
import { CAR_PROFILES, isLargeBodyType, type SceneCar } from './site-layout-car';
import { AC_HOLSTER, DC_HOLSTER, dcDispenserCableM } from './site-layout-charger-cables';
import { holsterSlots, type ConnectorKind } from './site-layout-connectors';
import { DC_BOLLARD, DC_CAR_FRONT_M, DC_CAR_TAIL_M } from './site-layout-dc-bollards';
import { carNoseAtStop, carTailAtStop, type WheelStopMount } from './site-layout-grid';
import { acGlandX } from './site-layout-model-ac-pedestal';
import { vehicleInletOf } from './site-layout-vehicle-inlet';

import { type SceneStation } from './site-layout-scene-types';

/** The connector type held in an EVSE's holster `connector` (the charging kind's default when unknown). */
export function slotKind(s: SceneStation, evse: number, connector: number): ConnectorKind {
  return s.connectorKinds?.[evse]?.[connector] ?? (s.kind === 'dc' ? 'ccs1' : 'type1');
}

/** Whether the handle of an EVSE's connector is plugged into the drawn vehicle (its holster is empty). */
export function slotInUse(s: SceneStation, evse: number, connector: number): boolean {
  if (s.stallCars != null) {
    return s.stallCars[evse] != null && (s.stallPlugged?.[evse] ?? 0) === connector;
  }
  return s.prop === 'car' && s.pluggedSlot?.evse === evse && s.pluggedSlot.connector === connector;
}

/** The plugged connector of a station's car and the holster it came from. */
export function pluggedHolster(s: SceneStation): {
  connector: ConnectorKind;
  side?: -1 | 1;
  backM?: number;
} {
  const evse = s.pluggedSlot?.evse ?? 0;
  const connector = s.pluggedSlot?.connector ?? 0;
  const kind = slotKind(s, evse, connector);
  if (s.evseConnectors == null) return { connector: kind };
  const slot = holsterSlots(s.evseConnectors).find(
    (h) => h.evse === evse && h.connector === connector,
  );
  return slot != null
    ? { connector: kind, side: slot.side, backM: slot.backM }
    : { connector: kind };
}

/** A plugged AC pedestal cable's gland, from the station's ports and the holster side. */
export function withAcGland(
  s: SceneStation,
  plug: ReturnType<typeof pluggedHolster>,
): ReturnType<typeof pluggedHolster> & { glandX?: number } {
  if (s.kind !== 'ac') return plug;
  const ports = Math.min(2, s.evseConnectors?.length ?? 1) === 2 ? 2 : 1;
  return { ...plug, glandX: acGlandX(ports, plug.side ?? -1) };
}

/**
 * The cable length of a standard DC dispenser station (not a split system):
 * a dispenser with two EVSEs serves two spots and carries the 6 m dual-outlet
 * cable (`dcDispenserCableM`); undefined for every other charger (its class
 * length).
 */
export function dcDispenserCableOf(s: SceneStation): number | undefined {
  if (s.kind !== 'dc' || (s.dispensers != null && s.dispensers.length > 1)) return undefined;
  return dcDispenserCableM(s.evseConnectors?.length ?? 1);
}

/** The bollards in front of a DC dispenser: their center line and front face (6 in pipe, `SITE_BOLLARD`). */
export const DC_BOLLARD_Z = DC_BOLLARD.z;
// Holsters on the side walls of the DC cabinet (DC_DISPENSER) and the AC
// pedestal head (AC_PEDESTAL), the cup center at a height that keeps the
// handle within the 15 to 48 in (0.38 to 1.22 m) reach range of the 2010 ADA
// Standards 308.2 and 308.3.
export const DC_HOLSTER_X = DC_HOLSTER.x;
export const DC_HOLSTER_Y = DC_HOLSTER.y;
export const AC_HOLSTER_X = AC_HOLSTER.x;
export const AC_HOLSTER_Y = AC_HOLSTER.y;

// Tube segments for a cable through `n` control points: two per point (a coiled
// wall box cable holds a hundred), at least 48, at most 400.
export function tubeSegments(n: number): number {
  return Math.min(400, Math.max(48, n * 2));
}

/** A holster on the side wall of a split system satellite at `dx` (300 mm wide plus its bevel). */
export function satelliteHolsterMount(dx: number, side: number, backM: number): Point3 {
  // A satellite is 0.3 m deep: a second holster on one side stands as far back as the wall allows.
  return {
    x: dx + side * (SPLIT_SYSTEM.dispenser.widthM / 2 + 0.015),
    y: 1.12,
    z: 0.04 - Math.min(backM, 0.12),
  };
}

/**
 * Where the end toward the charger of a car with no wheel stop stands: the
 * default gap, or at a DC dispenser its nose 0.3 m clear of the bollards
 * (`DC_CAR_FRONT_M`), or, backed in, its tail 36 in past them (`DC_CAR_TAIL_M`).
 */
export function carFrontWithoutStop(s: SceneStation, look: SceneCar): number | undefined {
  if (s.kind !== 'dc' || isLargeBodyType(look.bodyType)) return undefined;
  return parksBackedIn(carLookPort(look)) ? DC_CAR_TAIL_M : DC_CAR_FRONT_M;
}

/** The inlet and plug of a car look, for template cache keys. */
export function inletKey(look: SceneCar): string {
  return `${look.inlet ?? ''}:${look.plug === null ? 'closed' : (look.plug ?? '')}`;
}

/**
 * A car look with the inlet for the plug it takes (`vehicleInletOf`, the
 * station's connector kinds decide a CHAdeMO car's AC inlet). A CHAdeMO car
 * charges at its nose, where its two inlets sit under one lid (Nissan Leaf):
 * its port is the nose port. Large vehicles keep their own port.
 */
export function withVehicleInlet(
  look: SceneCar,
  plug: ConnectorKind,
  stationKinds: readonly ConnectorKind[] = [],
): SceneCar {
  const inlet = vehicleInletOf(plug, stationKinds);
  const chademo = inlet === 'chademo_type1' || inlet === 'chademo_type2';
  return {
    ...look,
    inlet,
    plug,
    ...(chademo && !isLargeBodyType(look.bodyType) ? { port: 'front_center' as const } : {}),
  };
}

/** The charge port a car look draws with (front left when none is known). */
export function carLookPort(look: SceneCar): CarPort {
  return look.port ?? 'front_left';
}

/** The end of a car toward the charger against a wheel stop: its nose, or its tail when it backs in. */
export function carFrontAtStop(mount: WheelStopMount, look: SceneCar): number | undefined {
  const bodyType = look.bodyType;
  if (isLargeBodyType(bodyType)) return undefined;
  const profile = CAR_PROFILES[bodyType];
  return parksBackedIn(carLookPort(look))
    ? carTailAtStop(mount, profile)
    : carNoseAtStop(mount, profile);
}
