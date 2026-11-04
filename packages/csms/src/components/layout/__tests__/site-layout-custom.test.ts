// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

// Custom sites (free positions), the charger screen message and the narrow
// stage framing: the pure helpers of the 2D and 3D views, without three.js.

import { describe, it, expect, vi } from 'vitest';

vi.mock('@/lib/api', () => ({ api: { get: vi.fn() } }));
vi.mock('@/lib/auth', () => ({ useHasPermission: () => false }));

import { freeFootprintsOverlap } from '@evtivity/lib/site-layout';
import {
  DENSE_WINDOW_M,
  NARROW_STAGE_PX,
  alignmentGuides,
  customSceneBox,
  denseFrameBox,
  freeBackPoint,
  handleRotation,
  pointsBox,
  rotationHandleZ,
} from '../site-layout-grid';
import { LANE_START_M, placePanels } from '../site-layout-links';
import {
  freeChargerModel,
  freePropOffset,
  freePropSpot,
  freeStationPlaces,
  stationConnectorTypes,
  layoutStationCountsOf,
} from '../site-layout-free';
import type { LayoutStation } from '../StationCard';

function station(id: string, evses: number, overrides: Partial<LayoutStation> = {}): LayoutStation {
  return {
    id,
    stationId: `CS-${id}`,
    model: null,
    status: 'available',
    isOnline: true,
    securityProfile: 1,
    positionX: 20,
    positionY: 20,
    placed: true,
    chargingKind: 'dc',
    cellular: false,
    inMaintenance: false,
    displayMessage: null,
    evses: Array.from({ length: evses }, (_, i) => ({
      evseId: i + 1,
      status: 'available',
      connectors: [
        {
          connectorId: 1,
          connectorType: 'CCS2',
          maxPowerKw: 150,
          status: 'available',
          isPluggedIn: false,
          energyDeliveredWh: null,
        },
      ],
    })),
    ...overrides,
  };
}

describe('custom site framing and links', () => {
  it('boxes the spots of every station and what stands beside them', () => {
    expect(pointsBox([])).toBeNull();
    expect(pointsBox([{ x: 1, z: 2 }], 1)).toEqual({ minX: 0, maxX: 2, minZ: 1, maxZ: 3 });
    const box = customSceneBox(
      [{ placement: { x: 0, z: 0, rotationDeg: 0 }, spots: 2 }],
      [{ x: -10, z: 0 }],
    );
    expect(box.minX).toBe(-12);
    expect(box.maxX).toBeCloseTo(4.6);
    expect(box.maxZ).toBeCloseTo(8.08);
  });

  it('ends a load management link behind the charger and stands the panels left of the stations', () => {
    const back = freeBackPoint({ x: 5, z: 5, rotationDeg: 180 });
    expect(back.x).toBeCloseTo(5);
    expect(back.z).toBeCloseTo(5.45);
    const ground = { minX: -20, maxX: 10, minZ: 0, maxZ: 30 };
    const panels = placePanels(
      [
        {
          id: 'p1',
          name: 'Main',
          breakerRatingAmps: 400,
          maxContinuousKw: 200,
          circuits: [],
          childPanels: [],
        },
      ],
      ground,
    );
    // Without a transformer: left of the stations' ground, beside the middle of its depth.
    expect(panels[0]?.point.z).toBe(15);
    expect(panels[0]?.point.x).toBeLessThanOrEqual(-20 - LANE_START_M);
  });
});

describe('custom site editing', () => {
  it('draws a guide to the nearest station sharing an x or a z', () => {
    const guides = alignmentGuides({ x: 10, z: 4 }, [
      { x: 10, z: 20 },
      { x: 10, z: 9 },
      { x: 3, z: 4 },
      { x: 7, z: 7 },
    ]);
    expect(guides).toEqual([
      { axis: 'x', from: { x: 10, z: 9 }, to: { x: 10, z: 4 } },
      { axis: 'z', from: { x: 3, z: 4 }, to: { x: 10, z: 4 } },
    ]);
    expect(alignmentGuides({ x: 0, z: 0 }, [{ x: 0.2, z: 5 }])).toEqual([]);
  });

  it('turns a station toward the pointer, by 15 degrees or freely with Shift', () => {
    // The handle stands in front of the spots (+z at no turn).
    expect(handleRotation({ x: 0, z: 0 }, { x: 0, z: 5 }, false)).toBe(0);
    // A pointer at -x: a quarter turn clockwise from above.
    expect(handleRotation({ x: 0, z: 0 }, { x: -5, z: 0 }, false)).toBe(90);
    expect(handleRotation({ x: 0, z: 0 }, { x: -5, z: 1 }, false)).toBe(75);
    expect(handleRotation({ x: 0, z: 0 }, { x: -5, z: 1 }, true)).toBeCloseTo(78.7, 1);
  });

  it('gives every station a free position and spots, picking one that overlaps nothing', () => {
    const places = freeStationPlaces([
      station('a', 2, { freePosition: { x: 0, z: 0, rotationDeg: 0 } }),
      station('b', 1),
      station('c', 4),
    ]);
    expect(places.get('a')).toEqual({ placement: { x: 0, z: 0, rotationDeg: 0 }, spots: 2 });
    expect(places.get('b')?.spots).toBe(1);
    // A DC station with four EVSEs: a split system, a car spot per dispenser.
    expect(places.get('c')?.spots).toBe(4);
    const list = [...places.values()];
    for (const p of list) {
      for (const o of list) if (p !== o) expect(freeFootprintsOverlap(p, o)).toBe(false);
    }
  });

  it('shows two saved facing stations whose spots now overlap apart, moving the second back', () => {
    // Saved while car spots began 0.9 m into the spot: 2 m apart then, 1 m overlap now.
    const places = freeStationPlaces([
      station('a', 2, { freePosition: { x: 0, z: 0, rotationDeg: 0 } }),
      station('b', 2, { freePosition: { x: 0, z: 11.2, rotationDeg: 180 } }),
      station('c', 1, { freePosition: { x: 30, z: 0, rotationDeg: 90 } }),
    ]);
    expect(places.get('a')?.placement).toEqual({ x: 0, z: 0, rotationDeg: 0 });
    expect(places.get('b')?.placement).toEqual({ x: 0, z: 12.2, rotationDeg: 180 });
    // A station clear of the others keeps its hand placement.
    expect(places.get('c')?.placement).toEqual({ x: 30, z: 0, rotationDeg: 90 });
    expect(freeFootprintsOverlap(places.get('a')!, places.get('b')!)).toBe(false);
  });

  it('puts the car of a two-spot station in the spot of its charging EVSE', () => {
    const two = station('a', 2);
    expect(freePropOffset(two, 2)).toBe(-1.3);
    expect(freePropOffset(station('b', 1), 1)).toBe(0);
    const second = station('c', 2);
    second.evses[1]!.connectors[0]!.isPluggedIn = true;
    expect(freePropOffset(second, 2)).toBe(1.3);
    const reserved = station('d', 2);
    reserved.evses[1]!.connectors[0]!.status = 'Reserved';
    expect(freePropOffset(reserved, 2)).toBe(1.3);
  });

  it('picks the charger model from the spot type, the charging kind and the connectors', () => {
    expect(freeChargerModel('car', 'dc', ['CCS2'])).toBe('standard');
    expect(freeChargerModel('bus_bay', 'dc', ['OppCharge', 'OppCharge'])).toBe('pantograph_down');
    expect(freeChargerModel('bus_bay', 'dc', ['Pan'])).toBe('pantograph_up');
    expect(freeChargerModel('bus_bay', 'dc', ['CCS1'])).toBe('bus_dispenser');
    expect(freeChargerModel('bus_bay', 'ac', ['Type2'])).toBe('standard');
    expect(freeChargerModel('truck_pull_through', 'dc', ['cMCS'])).toBe('truck_mcs');
    expect(freeChargerModel('truck_pull_through', 'ac', ['Type2'])).toBe('standard');
    const pantograph = station('p', 2);
    for (const e of pantograph.evses) e.connectors[0]!.connectorType = 'OppCharge';
    expect(stationConnectorTypes(pantograph)).toEqual(['OppCharge', 'OppCharge']);
  });

  it('puts the vehicle of a two-spot station in the spot of its charging EVSE', () => {
    const second = station('c', 2);
    second.evses[1]!.connectors[0]!.isPluggedIn = true;
    expect(freePropSpot(second, 2)).toBe(1);
    expect(freePropSpot(station('a', 2), 2)).toBe(0);
    expect(freePropSpot(second, 1)).toBe(0);
  });

  it('counts the stations by depot kind from their connectors', () => {
    const truck = station('t', 1);
    truck.evses[0]!.connectors[0]!.connectorType = 'cMCS';
    const pantograph = station('p', 1);
    pantograph.evses[0]!.connectors[0]!.connectorType = 'OppCharge';
    expect(layoutStationCountsOf([truck, pantograph, station('c', 2)])).toMatchObject({
      total: 3,
      bus: 2,
      truck: 1,
    });
  });

  it('stands the rotation handle 1.6 m past the back of the spots of every type', () => {
    expect(rotationHandleZ(2)).toBeCloseTo(7.68);
    expect(rotationHandleZ(2, 'bus_bay')).toBe(14.7);
    expect(rotationHandleZ(2, 'truck_pull_through')).toBe(14.6);
  });
});

describe('framing dense sites on phones', () => {
  it('frames the densest part of a wide site on a narrow stage, and the whole on a wide one', () => {
    const box = { minX: 0, maxX: 120, minZ: -5, maxZ: 15 };
    const stations = [
      { x: 2, z: 0 },
      { x: 60, z: 0 },
      { x: 63, z: 0 },
      { x: 66, z: 0 },
      { x: 69, z: 0 },
      { x: 118, z: 0 },
    ];
    expect(denseFrameBox(box, stations, NARROW_STAGE_PX)).toBe(box);
    const dense = denseFrameBox(box, stations, 375);
    expect(dense.maxX - dense.minX).toBe(DENSE_WINDOW_M);
    expect(dense.minX).toBeLessThanOrEqual(60);
    expect(dense.maxX).toBeGreaterThanOrEqual(69);
    expect(dense.minZ).toBe(-5);
    // A site that is not wide keeps its box.
    const square = { minX: 0, maxX: 40, minZ: 0, maxZ: 40 };
    expect(denseFrameBox(square, stations, 375)).toBe(square);
    // A deep site frames along z.
    const deep = denseFrameBox(
      { minX: 0, maxX: 10, minZ: 0, maxZ: 100 },
      [
        { x: 5, z: 80 },
        { x: 5, z: 85 },
        { x: 5, z: 10 },
      ],
      375,
    );
    expect(deep.minZ).toBeGreaterThan(50);
  });
});
