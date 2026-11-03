// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { describe, expect, it } from 'vitest';
import { TRUCK_CAB_DOOR, createTruckCabDoorKit } from '../site-layout-model-truck-cab-door';
import { kitBounds } from './vehicle-detail-bounds';

const input = {
  halfWidth: 1.25,
  front: 2.12,
  rear: 2.87,
  bottom: 0.72,
  top: 2.88,
  windowBottom: 2.2,
  steps: [0.45],
};

describe('truck cab door', () => {
  it('keeps the first step within 24 in of the ground', () => {
    expect(input.steps[0]).toBeLessThanOrEqual(TRUCK_CAB_DOOR.firstStepMaxM);
  });

  it('puts the door, steps and grab handles on both sides of the cab', () => {
    const kit = createTruckCabDoorKit(input);
    const b = kitBounds(kit);
    expect(b.min.x).toBeCloseTo(-b.max.x, 3);
    expect(b.max.x).toBeLessThan(input.halfWidth + 0.1);
    expect(b.min.y).toBeLessThan(0.45);
    expect(b.min.z).toBeLessThan(input.front);
    expect(b.max.z).toBeGreaterThan(input.rear);
    expect(kit.slotTriangles.rim).toBeGreaterThan(0);
    expect(kit.triangles).toBeLessThan(900);
  });
});
