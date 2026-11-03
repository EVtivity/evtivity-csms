// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import * as THREE from 'three';
import { DEPOT_SLOTS, type DepotMaterials } from '../site-layout-model-scissor';

export function depotMaterials(): DepotMaterials {
  const m = new THREE.MeshBasicMaterial();
  return Object.fromEntries(DEPOT_SLOTS.map((s) => [s, m])) as unknown as DepotMaterials;
}

export function boundsOf(o: THREE.Object3D): THREE.Box3 {
  o.updateMatrixWorld(true);
  return new THREE.Box3().setFromObject(o);
}
