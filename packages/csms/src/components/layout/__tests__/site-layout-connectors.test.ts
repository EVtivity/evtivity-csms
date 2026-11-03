// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { describe, it, expect } from 'vitest';
import { sceneSource } from './helpers/scene-source';
import {
  CONNECTOR_SPECS,
  HOLSTER_PITCH_M,
  HOLSTER_DEPTH_M,
  HOLSTER_SEAT_M,
  cableRadiusOf,
  connectorKindOf,
  faceBottomY,
  faceOutline,
  faceTopY,
  holsterPose,
  insertOutlines,
  type ConnectorKind,
  handleCableEndLocal,
  holsterSlots,
  isDcConnectorKind,
  plugCableEnd,
  plugYaw,
} from '../site-layout-connectors';

function inside(
  poly: ReadonlyArray<readonly [number, number]>,
  [x, y]: readonly [number, number],
): boolean {
  let hit = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i, i += 1) {
    const [xi, yi] = poly[i] ?? [0, 0];
    const [xj, yj] = poly[j] ?? [0, 0];
    if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) hit = !hit;
  }
  return hit;
}

function area(poly: ReadonlyArray<readonly [number, number]>): number {
  let a = 0;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i, i += 1) {
    const [xi, yi] = poly[i] ?? [0, 0];
    const [xj, yj] = poly[j] ?? [0, 0];
    a += xj * yi - xi * yj;
  }
  return a / 2;
}

describe('connector types', () => {
  it('reads every OCPP and CSMS spelling of the six plug types', () => {
    expect(connectorKindOf('Type1', false)).toBe('type1');
    expect(connectorKindOf('cType1', false)).toBe('type1');
    expect(connectorKindOf('J1772', false)).toBe('type1');
    expect(connectorKindOf('Type2', false)).toBe('type2');
    expect(connectorKindOf('sType2', false)).toBe('type2');
    expect(connectorKindOf('CCS1', true)).toBe('ccs1');
    expect(connectorKindOf('cCCS2', true)).toBe('ccs2');
    expect(connectorKindOf('CHAdeMO', true)).toBe('chademo');
    expect(connectorKindOf('cG105', true)).toBe('chademo');
    expect(connectorKindOf('NACS', true)).toBe('nacs');
    expect(connectorKindOf('Tesla', false)).toBe('nacs');
    expect(connectorKindOf('cMCS', true)).toBe('mcs');
    // Unknown: the charging kind's North American default.
    expect(connectorKindOf(null, true)).toBe('ccs1');
    expect(connectorKindOf('GBT', false)).toBe('type1');
  });

  it('draws each type in its real proportions', () => {
    const s = CONNECTOR_SPECS;
    // Combo plugs are the AC face over a DC lobe; the AC plugs have none.
    expect(s.ccs1.dcBlockHeightM).toBeGreaterThan(0);
    expect(s.ccs2.dcBlockHeightM).toBeGreaterThan(0);
    expect(s.type1.dcBlockHeightM).toBe(0);
    expect(s.type2.dcBlockHeightM).toBe(0);
    // J1772 round with its key tab at the bottom and the thumb latch, Type 2
    // cut flat at the top, NACS and MCS tapered, CHAdeMO and MCS a lever.
    expect([s.type1.face, s.type1.latch]).toEqual(['round', 'thumb']);
    expect(s.type1.keyTab).toEqual({ widthM: 0.008, radiusM: 0.0252 });
    expect(s.type1.flatTopRatio).toBeNull();
    expect(s.type2.flatTopRatio).not.toBeNull();
    expect([s.nacs.face, s.nacs.latch]).toEqual(['tapered', 'button']);
    expect([s.mcs.face, s.mcs.latch]).toEqual(['tapered', 'lever']);
    expect(s.chademo.latch).toBe('lever');
    // CHAdeMO 86 mm across, the J1772 nose 43.8 mm (Amphenol), the NACS face 41 by 43 mm (Tesla TS-0023666 p.13, scaled).
    expect(s.chademo.faceWidthM).toBeCloseTo(0.086, 9);
    expect(s.type1.faceWidthM).toBeCloseTo(0.0438, 9);
    expect([s.nacs.faceWidthM, s.nacs.faceHeightM]).toEqual([0.041, 0.043]);
    // CCS DC pins 26 mm apart (J1772 sheet C-3), the CCS1 DC lobe 59 mm wide.
    const dc = s.ccs1.contacts.filter((c) => c.role === 'dc');
    expect(dc).toHaveLength(2);
    expect((dc[1]?.x ?? 0) - (dc[0]?.x ?? 0)).toBeCloseTo(0.026, 9);
    expect(s.ccs1.dcBlockWidthM).toBeCloseTo(0.059, 9);
    // ... and their center 42 mm below the AC center (sheet C-2).
    expect(dc[0]?.y).toBeCloseTo(-0.042, 9);
    expect(s.ccs1.dcCenterYM).toBeCloseTo(-0.042, 9);
    // J1772 socket openings (detail K): power 3.9 mm, PE 3.1 mm 10.8 mm below center, CP and PP 1.8 mm.
    expect(s.type1.contacts.map((c) => c.d)).toEqual([0.0039, 0.0039, 0.0031, 0.0018, 0.0018]);
    expect(s.type1.contacts.find((c) => c.role === 'ground')?.y).toBeCloseTo(-0.0108, 9);
    // The plug faces carry their published contact counts.
    expect(s.type1.contacts).toHaveLength(5);
    expect(s.type2.contacts).toHaveLength(7);
    expect(s.chademo.contacts).toHaveLength(10);
    expect(s.nacs.contacts).toHaveLength(5);
    expect(s.mcs.contacts).toHaveLength(7);
    // A combo plug has no AC power contacts in its AC face.
    expect(s.ccs1.contacts.filter((c) => c.role === 'power')).toHaveLength(0);
    expect(s.ccs2.contacts.filter((c) => c.role === 'power')).toHaveLength(0);
    // DC cables are thicker than AC ones (CCS1 35.3 mm, Type 2 16 mm).
    expect(s.ccs1.cableDiameterM).toBeCloseTo(0.0353, 9);
    expect(s.type2.cableDiameterM).toBeCloseTo(0.016, 9);
    for (const kind of ['ccs1', 'ccs2', 'chademo', 'nacs'] as const) {
      expect(isDcConnectorKind(kind)).toBe(true);
      expect(s[kind].cableDiameterM).toBeGreaterThan(s.type2.cableDiameterM);
    }
    expect(cableRadiusOf(['type1', 'ccs1'])).toBeCloseTo(0.0353 / 2, 9);
  });

  it('keeps every contact opening inside its face insert, clear of the others', () => {
    for (const kind of Object.keys(CONNECTOR_SPECS) as ConnectorKind[]) {
      const spec = CONNECTOR_SPECS[kind];
      const inserts = insertOutlines(spec);
      for (const c of spec.contacts) {
        // Every point of the opening's edge lies inside one insert outline.
        const insert = inserts.find((o) => inside(o, [c.x, c.y])) ?? [];
        expect(insert.length, `${kind} contact at ${String(c.x)}, ${String(c.y)}`).toBeGreaterThan(
          0,
        );
        for (let i = 0; i < 16; i += 1) {
          const a = (i / 16) * Math.PI * 2;
          const p: [number, number] = [
            c.x + (Math.cos(a) * c.d) / 2,
            c.y + (Math.sin(a) * c.d) / 2,
          ];
          expect(inside(insert, p), `${kind} contact at ${String(c.x)}, ${String(c.y)}`).toBe(true);
        }
      }
      // Each insert lies inside the face outline.
      const face = faceOutline(spec);
      for (const o of inserts) for (const p of o) expect(inside(face, p), kind).toBe(true);
      spec.contacts.forEach((c, i) => {
        for (const o of spec.contacts.slice(i + 1)) {
          expect(Math.hypot(c.x - o.x, c.y - o.y), kind).toBeGreaterThan((c.d + o.d) / 2);
        }
      });
    }
  });

  it('outlines the faces counter clockwise and grows them for the holster cup', () => {
    for (const kind of Object.keys(CONNECTOR_SPECS) as ConnectorKind[]) {
      const spec = CONNECTOR_SPECS[kind];
      const face = faceOutline(spec);
      expect(area(face), kind).toBeGreaterThan(0);
      const cup = faceOutline(spec, 0.0015);
      // The cup mouth takes the whole face outline.
      for (const p of face) expect(inside(cup, p), kind).toBe(true);
      const ys = face.map((p) => p[1]);
      expect(Math.min(...ys), kind).toBeCloseTo(faceBottomY(spec), 3);
      expect(Math.max(...ys), kind).toBeCloseTo(faceTopY(spec), 3);
    }
  });

  it('seats a holstered handle nose first in its cup, facing back into the charger', () => {
    const pose = holsterPose({ x: 0.4, y: 1.1, z: 0.1 }, { x: 1, z: 0 });
    expect(pose.mouth.x).toBeCloseTo(0.4 + HOLSTER_DEPTH_M, 9);
    expect(pose.handle.x).toBeCloseTo(pose.mouth.x - HOLSTER_SEAT_M, 9);
    expect(pose.handle.x).toBeGreaterThan(0.4);
    // The handle face (+z turned by yaw) points -x, back into the cup.
    expect(Math.sin(pose.handleYaw)).toBeCloseTo(-1, 9);
    expect(Math.sin(pose.holsterYaw)).toBeCloseTo(1, 9);
    // Its cable leaves the boot out to the side, below the cup.
    const end = plugCableEnd(pose.handle, pose.handleYaw, 'ccs1');
    expect(end[0]).toBeGreaterThan(pose.mouth.x);
    expect(end[1]).toBeLessThan(pose.mouth.y);
  });

  it('puts two EVSEs in their own holsters, a second connector below the first', () => {
    expect(holsterSlots([1])).toEqual([{ evse: 0, connector: 0, side: -1, backM: 0 }]);
    expect(holsterSlots([1, 1]).map((h) => [h.evse, h.side])).toEqual([
      [0, -1],
      [1, 1],
    ]);
    expect(holsterSlots([2, 2])).toEqual([
      { evse: 0, connector: 0, side: -1, backM: 0 },
      { evse: 0, connector: 1, side: -1, backM: HOLSTER_PITCH_M },
      { evse: 1, connector: 0, side: 1, backM: 0 },
      { evse: 1, connector: 1, side: 1, backM: HOLSTER_PITCH_M },
    ]);
    // One EVSE with two cables: left and right.
    expect(holsterSlots([2]).map((h) => h.side)).toEqual([-1, 1]);
  });

  it('plugs the handle into the port with its face into the car and the cable from its grip', () => {
    // A left side port faces -x: the handle face points +x into the car.
    expect(plugYaw({ x: -1 }, 0, false)).toBeCloseTo(Math.PI / 2, 9);
    expect(plugYaw({ x: 1 }, 0, false)).toBeCloseTo(-Math.PI / 2, 9);
    expect(plugYaw({ x: 0 }, 0, true)).toBe(0);
    const port = { x: -1, y: 0.74, z: 1.3 };
    const yaw = plugYaw(port, 0, false);
    const end = plugCableEnd(port, yaw, 'ccs1');
    // Out from the car side and down the grip.
    expect(end[0]).toBeLessThan(port.x);
    expect(end[1]).toBeLessThan(port.y);
    expect(end[2]).toBeCloseTo(port.z, 9);
    const local = handleCableEndLocal('ccs1');
    expect(Math.hypot(end[0] - port.x, end[2] - port.z)).toBeCloseTo(-local.z, 9);
  });

  it('builds every holster and plug from the connector model of its type', () => {
    expect(sceneSource).not.toMatch(/\bhandle\(rubber\)|heavyHandle/);
    // Every charger holster is the holster model of its connector type with its handle seated.
    expect(sceneSource.match(/holsteredConnector\(/g)?.length ?? 0).toBeGreaterThanOrEqual(7);
    expect(sceneSource).not.toMatch(/const holster = box\(/);
    // A plugged connector leaves its holster empty.
    expect(sceneSource.match(/slotInUse\(s, /g)?.length ?? 0).toBeGreaterThanOrEqual(4);
  });
});
