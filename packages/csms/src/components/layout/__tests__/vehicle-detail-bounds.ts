// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import * as THREE from 'three';

/** The bounding box of every geometry of a kit. */
export function kitBounds(kit: { geometries: readonly THREE.BufferGeometry[] }): THREE.Box3 {
  const box = new THREE.Box3();
  for (const g of kit.geometries) {
    g.computeBoundingBox();
    if (g.boundingBox != null) box.union(g.boundingBox);
  }
  return box;
}
