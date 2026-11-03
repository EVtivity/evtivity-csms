// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { describe, expect, it } from 'vitest';
import {
  PANTOGRAPH_DROP,
  PANTOGRAPH_HOUSING_BOTTOM_Y,
  PANTOGRAPH_POLE,
  PANTOGRAPH_POLE_LOGO,
  buildPantographPole,
  createPantographLinkageKit,
  createPantographPoleKit,
  pantographDropFor,
} from '../site-layout-model-pantograph-pole';
import { CHARGER_LOGO_FACES, CHARGER_LOGO_PANELS } from '../site-layout-grid';
import { boundsOf, depotMaterials } from './depot-model-helpers';

describe('pantograph pole (ABB HVC-PD)', () => {
  it('stands 5.24 m high with the boom reaching past 4.67 m, under 3000 triangles', () => {
    const kit = createPantographPoleKit({ headXs: [-2.2, 2.2] });
    expect(kit.triangles).toBeLessThan(3000);
    const b = boundsOf(kit.build(depotMaterials()));
    expect(b.max.y).toBeCloseTo(PANTOGRAPH_POLE.boomY + PANTOGRAPH_POLE.boom.heightM / 2, 1);
    expect(b.max.y).toBeGreaterThanOrEqual(PANTOGRAPH_POLE.heightM);
    expect(b.max.z).toBeGreaterThan(
      PANTOGRAPH_POLE.outreachM + PANTOGRAPH_POLE.housing.depthM / 2 - 0.01,
    );
    expect(b.min.y).toBeCloseTo(0, 3);
    // The crossbar covers both frames.
    expect(b.max.x - b.min.x).toBeGreaterThan(4.4 + PANTOGRAPH_POLE.housing.widthM - 0.01);
  });

  it('builds the linkage to the drop asked for, under 2000 triangles', () => {
    for (const drop of [PANTOGRAPH_DROP.minM, 0.9, 1.25, PANTOGRAPH_DROP.maxM]) {
      const kit = createPantographLinkageKit(drop);
      expect(kit.triangles, String(drop)).toBeLessThan(2000);
      const b = boundsOf(kit.build(depotMaterials()));
      expect(b.min.y, String(drop)).toBeCloseTo(-drop, 2);
      expect(b.max.y, String(drop)).toBeLessThan(0.15);
    }
  });

  it('lowers the head onto a 3.4 m bus roof and parks it above the bus when raised', () => {
    const drop = pantographDropFor(3.42);
    expect(PANTOGRAPH_HOUSING_BOTTOM_Y - drop).toBeCloseTo(3.42, 3);
    expect(PANTOGRAPH_HOUSING_BOTTOM_Y - PANTOGRAPH_DROP.minM).toBeGreaterThan(3.4 + 0.5);
  });

  it('names one linkage child per head for the scene to swap', () => {
    const g = buildPantographPole(depotMaterials(), [
      { x: -2, dropM: 0.5 },
      { x: 2, dropM: 1.2 },
    ]);
    expect(g.getObjectByName('pantograph-0')).toBeDefined();
    expect(g.getObjectByName('pantograph-1')?.position.y).toBeCloseTo(
      PANTOGRAPH_HOUSING_BOTTOM_Y,
      6,
    );
  });

  it('puts the logo on the module side facing the bay entrance, never on the front', () => {
    const m = PANTOGRAPH_POLE.module;
    for (const model of ['pantograph_down', 'pantograph_up'] as const) {
      const panel = CHARGER_LOGO_PANELS[model];
      const face = CHARGER_LOGO_FACES[model];
      expect(panel.turn).toBeCloseTo(-Math.PI / 2, 9);
      expect(panel.width).toBe(PANTOGRAPH_POLE_LOGO.widthM);
      expect(panel.height).toBe(PANTOGRAPH_POLE_LOGO.heightM);
      expect(panel.y).toBe(PANTOGRAPH_POLE_LOGO.y);
      expect(panel.z).toBeCloseTo(PANTOGRAPH_POLE_LOGO.outM, 9);
      // The side face: the module depth, flat between its 0.03 m rounded edges.
      expect(face.width).toBe(m.depthM);
      expect(face.flatWidth).toBeCloseTo(m.depthM - 0.06, 9);
      expect(face.z).toBe(m.widthM / 2);
      expect(face.maxY).toBeLessThanOrEqual(m.bottomM + m.heightM);
    }
    // Clear of the screen bezel on the front: the plate is off the front plane entirely.
    expect(PANTOGRAPH_POLE_LOGO.centerZ).toBeCloseTo(PANTOGRAPH_POLE.poleM / 2 + m.depthM / 2, 9);
  });
});
