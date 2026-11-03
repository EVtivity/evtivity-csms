// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

// The vehicle kit of any body type: a car from its side profile
// (site-layout-car-geometry.ts) or a large vehicle
// (site-layout-large-vehicle-geometry.ts). The scene builds every vehicle
// through this one entry.

import type { VehicleBodyType } from '@evtivity/lib/vehicle-appearance';
import type { CarPort } from './site-layout-cable';
import { isLargeBodyType } from './site-layout-car';
import { createCarKit, type CarKit } from './site-layout-car-geometry';
import { createLargeVehicleKit } from './site-layout-large-vehicle-geometry';

export function createVehicleKit(bodyType: VehicleBodyType, port?: CarPort): CarKit {
  return isLargeBodyType(bodyType) ? createLargeVehicleKit(bodyType) : createCarKit(bodyType, port);
}
