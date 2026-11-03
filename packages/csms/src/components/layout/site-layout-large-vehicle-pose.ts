// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

// Where the vehicle of a large spot (a depot bus bay or truck lane) stands,
// in the station frame, and where its charge inlet and roof contact land.

import type { FreeSpotRect } from '@evtivity/lib/site-layout';
import * as THREE from 'three';
import type { CarKit } from './site-layout-car-geometry';

/** The bus nose in a bay: 0.9 m in front of the charger at the bay head. */
export const LARGE_NOSE_Z = 0.9;
/** A truck drives through its lane with the inlet this far past its dispenser. */
export const TRUCK_INLET_PAST_DISPENSER_M = 0.8;
/** The truck's left side this far from the lane island. */
export const TRUCK_SIDE_FROM_ISLAND_M = 0.4;

export interface LargeVehiclePose {
  x: number;
  z: number;
  turn: number;
  port: THREE.Vector3;
  roof: THREE.Vector3 | null;
}

/**
 * The pose of a vehicle in `rect`: nose to the charger in a bus bay (or a car
 * spot), driving through a truck lane with its charge inlet just past the
 * dispenser and its left side to the island.
 */
export function largeVehiclePose(
  rect: FreeSpotRect,
  kit: Pick<CarKit, 'port' | 'roofContact'>,
  widthM: number,
): LargeVehiclePose {
  if (rect.heading === '+x') {
    // Turned -90 degrees: the vehicle's -z (forward) becomes +x, its left side -z.
    const x = Math.min(rect.maxX - 0.3, rect.chargerX + TRUCK_INLET_PAST_DISPENSER_M + kit.port.z);
    const z = rect.minZ + TRUCK_SIDE_FROM_ISLAND_M + widthM / 2;
    const port = new THREE.Vector3(x - kit.port.z, kit.port.y, z + kit.port.x);
    const roof =
      kit.roofContact != null
        ? new THREE.Vector3(x - kit.roofContact.z, kit.roofContact.y, z + kit.roofContact.x)
        : null;
    return { x, z, turn: -Math.PI / 2, port, roof };
  }
  const x = (rect.minX + rect.maxX) / 2;
  const z = LARGE_NOSE_Z;
  const port = new THREE.Vector3(x + kit.port.x, kit.port.y, z + kit.port.z);
  const roof =
    kit.roofContact != null
      ? new THREE.Vector3(x + kit.roofContact.x, kit.roofContact.y, z + kit.roofContact.z)
      : null;
  return { x, z, turn: 0, port, roof };
}

/**
 * The contact point of a bay's pantograph: over the middle of the bay, where
 * a bus's roof rails stop (`LARGE_NOSE_Z` plus the rails' distance from its nose).
 */
export function pantographPoint(rect: FreeSpotRect, busRoofContact: THREE.Vector3): THREE.Vector3 {
  return new THREE.Vector3(
    (rect.minX + rect.maxX) / 2,
    busRoofContact.y,
    LARGE_NOSE_Z + busRoofContact.z,
  );
}
