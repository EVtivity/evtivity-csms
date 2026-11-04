// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { describe, expect, it } from 'vitest';
import { CAR_BODY_TYPES, CAR_PROFILES, type CarBodyType } from '../site-layout-car';
import {
  bodyTopAt,
  carDoorLayout,
  createCarDoorDetailKit,
  type CarDoorDetailInput,
} from '../site-layout-model-car-doors';
import { kitBounds } from './vehicle-detail-bounds';

function input(bodyType: CarBodyType): CarDoorDetailInput {
  const profile = CAR_PROFILES[bodyType];
  const first = profile.glass[0]?.[0] ?? 1.5;
  const last = profile.glass[profile.glass.length - 1]?.[0] ?? 4;
  return {
    bodyType,
    profile,
    edgeAt: () => profile.width * 0.45,
    bPillarU: (first + last) / 2 - 0.1,
  };
}

describe('car door details', () => {
  it('reads the body top along the profile', () => {
    const p = CAR_PROFILES.sedan;
    expect(bodyTopAt(p, 2.6)).toBeCloseTo(0.97, 2);
    expect(bodyTopAt(p, 2.1)).toBeGreaterThan(0.94);
  });

  it('puts the shut lines between the wheel arches, in order, on both sides', () => {
    for (const bodyType of CAR_BODY_TYPES) {
      const p = CAR_PROFILES[bodyType];
      const sides = carDoorLayout(input(bodyType));
      expect(sides.map((s) => s.side).sort()).toEqual([-1, 1]);
      for (const s of sides) {
        expect(s.seams).toEqual([...s.seams].sort((a, b) => a - b));
        expect(Math.min(...s.seams), bodyType).toBeGreaterThan(p.frontAxle + p.wheelRadius);
        expect(Math.max(...s.seams), bodyType).toBeLessThan(p.rearAxle - p.wheelRadius + 0.01);
      }
    }
  });

  it('gives the van a sliding door and its track on the right only', () => {
    const [left, right] = carDoorLayout(input('van'));
    expect(left?.track).toBeUndefined();
    expect(right?.track).toBeDefined();
    expect(right?.seams).toHaveLength(3);
  });

  it('stays on the body and within a small budget for every type and port', () => {
    for (const bodyType of CAR_BODY_TYPES) {
      const p = CAR_PROFILES[bodyType];
      const kit = createCarDoorDetailKit(input(bodyType));
      expect(kit.triangles, bodyType).toBeLessThan(1200);
      expect(Object.keys(kit.slotTriangles).sort()).toEqual(['rim', 'trim']);
      const b = kitBounds(kit);
      expect(b.max.x).toBeLessThan(p.width / 2 + 0.05);
      expect(b.min.z).toBeGreaterThan(-0.05);
      expect(b.max.z).toBeLessThan(p.length + 0.05);
    }
  });
});
