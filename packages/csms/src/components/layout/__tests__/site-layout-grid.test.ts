// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { describe, it, expect } from 'vitest';
import sceneSource from '../site-layout-scene.ts?raw';
import {
  DEFAULT_LAYOUT_GRID,
  bayToPosition,
  effectiveLayoutSettings,
  positionToBay,
  type SiteLayoutSettings,
} from '@evtivity/lib/site-layout';
import {
  BAY_STATION_Z,
  CURB_M,
  CURB_POST_BACK_M,
  CURB_POST_IN_M,
  FACADE_Z,
  SIDEWALK_M,
  buildingBox,
  buildingFramePoints,
  beaconLevel,
  LABEL_CULL_FROM,
  stationLabelInRange,
  OVERHEAD_BADGE,
  overheadBadgeScale,
  overheadBadgesCrowded,
  CROWDED_MARKER_SHARE,
  pixelsPerMeter,
  CHARGER_LOGO_FACES,
  chargingGlowLevel,
  wallBoxOffset,
  wallMounted,
  MAX_DISTANCE_MIN,
  MAX_POLAR_ANGLE,
  MIN_CAMERA_HEIGHT,
  clampCameraHeight,
  FRONT_TARGET_Y,
  OVERVIEW_CAMERA_OFFSET,
  MIN_DISTANCE,
  STATION_BACK_OFFSET,
  bayToWorld,
  bayTurn,
  chargersAtBack,
  clampTarget,
  depotStationPlacement,
  clampToLot,
  fitFrame,
  fogRange,
  frontCamera,
  groundBox,
  isSpot,
  layoutGroundBox,
  logoFit,
  virtualSignOf,
  CHARGER_LOGO_PANELS,
  type ChargerLogoModel,
  lotOf,
  maxZoomDistance,
  panBox,
  rotateBox,
  sceneBox,
  spotRect,
  stationBackPoint,
  stationProp,
  worldToBay,
} from '../site-layout-grid';

const lot = lotOf(DEFAULT_LAYOUT_GRID);
const office = lotOf({ ...DEFAULT_LAYOUT_GRID, siteType: 'office_retail', chargers: 6 });
const officeStall = lotOf({
  ...DEFAULT_LAYOUT_GRID,
  siteType: 'office_retail',
  chargers: 6,
  mounting: 'stall',
});
const street = lotOf({
  ...DEFAULT_LAYOUT_GRID,
  siteType: 'curbside',
  chargersLeft: 4,
  chargersRight: 6,
});

describe('site layout 3D lot', () => {
  it('takes the default lot of 2 rows of 10 standard spots with a two-way aisle between the rows', () => {
    expect(lot).toMatchObject({
      cols: 10,
      rows: 2,
      spotW: 2.6,
      spotD: 5.5,
      lane: 7.3,
      pitch: 12.8,
    });
    expect(lot.rowLengths).toEqual([10, 10]);
    expect(lot.width).toBeCloseTo(26);
    expect(lot.depth).toBeCloseTo(18.3);
    expect(lot.facing).toBe(-0);
  });

  it('maps every spot to the lot and back, and to the same stored 2D position', () => {
    for (const bay of [
      { col: 0, row: 0 },
      { col: 4, row: 1 },
      { col: 9, row: 1 },
    ]) {
      const p = bayToWorld(bay, lot);
      expect(worldToBay(p.x, p.z, lot)).toEqual(bay);
      // Anywhere in the spot, from its front edge to its back edge.
      const z0 = lot.pitch * bay.row;
      expect(worldToBay(p.x + lot.spotW * 0.45, z0 + 0.05, lot)).toEqual(bay);
      expect(worldToBay(p.x - lot.spotW * 0.45, z0 + lot.spotD - 0.05, lot)).toEqual(bay);
      expect(positionToBay(bayToPosition(bay))).toEqual(bay);
      expect(spotRect(bay, lot)).toEqual({
        minX: lot.spotW * bay.col,
        maxX: lot.spotW * bay.col + lot.spotW,
        minZ: z0,
        maxZ: z0 + lot.spotD,
      });
    }
  });

  it('spaces the rows by the standard spot depth plus the aisle', () => {
    expect(bayToWorld({ col: 2, row: 0 }, lot)).toEqual({ x: 6.5, z: BAY_STATION_Z });
    // Row 1 is turned: its chargers stand at its back edge, 12.8 + 5.5 m.
    expect(bayToWorld({ col: 2, row: 1 }, lot).z).toBeCloseTo(18.3 - BAY_STATION_Z);
  });

  it('puts the chargers of both rows of the default lot at the outer edges, bays opening onto the lane', () => {
    const row0 = bayToWorld({ col: 3, row: 0 }, lot);
    const row1 = bayToWorld({ col: 3, row: 1 }, lot);
    expect(row0.z).toBeCloseTo(BAY_STATION_Z);
    expect(row1.z).toBeCloseTo(lot.depth - BAY_STATION_Z);
    expect(bayTurn({ col: 3, row: 0 }, lot)).toBe(0);
    expect(bayTurn({ col: 3, row: 1 }, lot)).toBeCloseTo(Math.PI);
    const laneMid = lot.spotD + lot.lane / 2;
    expect(Math.sign(laneMid - row0.z)).toBe(Math.cos(bayTurn({ col: 3, row: 0 }, lot)));
    expect(Math.sign(laneMid - row1.z)).toBeCloseTo(Math.cos(bayTurn({ col: 3, row: 1 }, lot)));
  });

  it('pairs rows around the lanes in a lot of more than two rows', () => {
    const rows = (n: number) => lotOf({ ...DEFAULT_LAYOUT_GRID, rows: n });
    const turned = (n: number) => Array.from({ length: n }, (_, r) => chargersAtBack(r, rows(n)));
    expect(turned(1)).toEqual([false]);
    expect(turned(2)).toEqual([false, true]);
    // An odd last row opens onto the lane before it: chargers at the back edge of the lot.
    expect(turned(3)).toEqual([false, true, true]);
    expect(turned(4)).toEqual([false, true, false, true]);
    expect(turned(5)).toEqual([false, true, false, true, true]);
    // A station on the grass below the lot keeps the unturned model.
    expect(chargersAtBack(3, rows(3))).toBe(false);
    const three = rows(3);
    expect(bayToWorld({ col: 0, row: 0 }, three).z).toBeCloseTo(BAY_STATION_Z);
    expect(bayToWorld({ col: 0, row: 2 }, three).z).toBeCloseTo(three.depth - BAY_STATION_Z);
    for (const row of [0, 1, 2]) {
      const p = bayToWorld({ col: 5, row }, three);
      expect(worldToBay(p.x, p.z, three)).toEqual({ col: 5, row });
    }
  });

  it('keeps the row arrangement under every facing (the facing turns the whole lot)', () => {
    for (const facingDeg of [0, 90, 180, 270] as const) {
      const turned = lotOf({ ...DEFAULT_LAYOUT_GRID, facingDeg });
      expect(bayToWorld({ col: 1, row: 1 }, turned)).toEqual(bayToWorld({ col: 1, row: 1 }, lot));
      expect(bayTurn({ col: 1, row: 1 }, turned)).toBeCloseTo(Math.PI);
    }
  });

  it('turns only a parking lot by its facing', () => {
    expect(lotOf({ ...DEFAULT_LAYOUT_GRID, facingDeg: 90 }).facing).toBeCloseTo(-Math.PI / 2);
    expect(
      lotOf({ ...DEFAULT_LAYOUT_GRID, facingDeg: 90, siteType: 'office_retail' }).facing,
    ).toBeCloseTo(0);
    expect(
      lotOf({ ...DEFAULT_LAYOUT_GRID, facingDeg: 90, siteType: 'curbside' }).facing,
    ).toBeCloseTo(0);
  });

  it('ends a load management link behind the charger, on the curb side of its row', () => {
    const front = stationBackPoint({ col: 2, row: 0 }, lot);
    const back = stationBackPoint({ col: 2, row: 1 }, lot);
    expect(front.z).toBeCloseTo(BAY_STATION_Z - STATION_BACK_OFFSET);
    expect(back.z).toBeCloseTo(lot.depth - BAY_STATION_Z + STATION_BACK_OFFSET);
    expect(back.x).toBeCloseTo(bayToWorld({ col: 2, row: 1 }, lot).x);
  });

  it('takes the site type into the lot, a parking lot by default', () => {
    expect(lot.siteType).toBe('parking_lot');
    expect(office.siteType).toBe('office_retail');
    expect(street.siteType).toBe('curbside');
  });

  it('gives an office or retail site one row of its chargers with the aisle in front of it', () => {
    expect(office).toMatchObject({ rows: 1, cols: 6, spotW: 2.6, spotD: 5.5, lane: 7.3 });
    expect(office.rowLengths).toEqual([6]);
    expect(office.depth).toBeCloseTo(12.8);
    expect(office.mounting).toBe('wall');
    expect(officeStall.mounting).toBe('stall');
    expect(chargersAtBack(0, office)).toBe(false);
    expect(isSpot({ col: 5, row: 0 }, office)).toBe(true);
    expect(isSpot({ col: 6, row: 0 }, office)).toBe(false);
    expect(isSpot({ col: 0, row: 1 }, office)).toBe(false);
  });

  it('hangs the AC chargers of a wall-mounted office or retail row on the facade, nothing else', () => {
    expect(wallMounted({ col: 3, row: 0 }, office, 'ac')).toBe(true);
    // A DC charger, a station off the row, stall posts and every other site type stand at the curb.
    expect(wallMounted({ col: 3, row: 0 }, office, 'dc')).toBe(false);
    expect(wallMounted({ col: 3, row: 1 }, office, 'ac')).toBe(false);
    expect(wallMounted({ col: 12, row: 0 }, office, 'ac')).toBe(false);
    expect(wallMounted({ col: 3, row: 0 }, officeStall, 'ac')).toBe(false);
    expect(wallMounted({ col: 3, row: 0 }, lot, 'ac')).toBe(false);
    expect(wallMounted({ col: 3, row: 0 }, street, 'ac')).toBe(false);
    // The wall box is on the facade behind its spot.
    expect(BAY_STATION_Z + wallBoxOffset()).toBeCloseTo(FACADE_Z);
  });

  it('puts the building along the front of the office or retail row past the sidewalk', () => {
    const b = buildingBox(office);
    expect(b.maxZ).toBeCloseTo(FACADE_Z);
    expect(FACADE_Z).toBeCloseTo(-(CURB_M + SIDEWALK_M));
    expect(b.minX).toBeLessThan(0);
    expect(b.maxX).toBeGreaterThan(office.width);
    // The framing takes in the facade, not the whole building behind it.
    for (const p of buildingFramePoints(office)) expect(p.z).toBeGreaterThan(b.minZ + 10);
    expect(layoutGroundBox(office).minZ).toBeCloseTo(FACADE_Z);
  });

  it('lays out a street: a parallel parking lane along each curb around two travel lanes', () => {
    expect(street).toMatchObject({ rows: 2, cols: 6, spotW: 6, spotD: 2.4, lane: 7 });
    expect(street.rowLengths).toEqual([4, 6]);
    expect(street.depth).toBeCloseTo(11.8);
    expect(street.width).toBeCloseTo(36);
    // The left curb faces the street (+z); the right curb is turned.
    expect(bayTurn({ col: 0, row: 0 }, street)).toBe(0);
    expect(bayTurn({ col: 0, row: 1 }, street)).toBeCloseTo(Math.PI);
    // Posts stand on the sidewalks behind the curbs, near the front end of their spot.
    const left = bayToWorld({ col: 2, row: 0 }, street);
    expect(left.z).toBeCloseTo(-(CURB_M + CURB_POST_BACK_M));
    expect(left.x).toBeCloseTo(12 + CURB_POST_IN_M);
    const right = bayToWorld({ col: 2, row: 1 }, street);
    expect(right.z).toBeCloseTo(street.depth + CURB_M + CURB_POST_BACK_M);
    expect(right.x).toBeCloseTo(18 - CURB_POST_IN_M);
    // The parallel spots are the parking lanes.
    expect(spotRect({ col: 2, row: 0 }, street)).toEqual({
      minX: 12,
      maxX: 18,
      minZ: 0,
      maxZ: 2.4,
    });
    expect(spotRect({ col: 2, row: 1 }, street).minZ).toBeCloseTo(9.4);
    // Both sidewalks belong to the site.
    const ground = layoutGroundBox(street);
    expect(ground.minZ).toBeCloseTo(-(CURB_M + SIDEWALK_M));
    expect(ground.maxZ).toBeCloseTo(street.depth + CURB_M + SIDEWALK_M);
    // Every post maps back to its own spot.
    for (const bay of [
      { col: 0, row: 0 },
      { col: 3, row: 0 },
      { col: 5, row: 1 },
    ]) {
      const p = bayToWorld(bay, street);
      expect(worldToBay(p.x, p.z, street)).toEqual(bay);
    }
  });

  it('never picks a curb without chargers', () => {
    const oneSide = lotOf({
      ...DEFAULT_LAYOUT_GRID,
      siteType: 'curbside',
      chargersLeft: 0,
      chargersRight: 3,
    });
    expect(oneSide.rowLengths).toEqual([0, 3]);
    expect(worldToBay(1, -1, oneSide)).toEqual({ col: 0, row: 1 });
    expect(isSpot({ col: 0, row: 0 }, oneSide)).toBe(false);
    expect(clampToLot(-50, -50, oneSide)).toEqual(bayToWorld({ col: 0, row: 1 }, oneSide));
  });

  it('pulses the charging glow gently, steady with reduced motion', () => {
    const steady = chargingGlowLevel(null);
    expect(chargingGlowLevel(null)).toEqual(steady);
    const levels = Array.from({ length: 60 }, (_, i) => chargingGlowLevel(i / 10));
    const intensities = levels.map((l) => l.intensity);
    expect(Math.max(...intensities) - Math.min(...intensities)).toBeGreaterThan(0.5);
    for (const l of levels) {
      expect(l.intensity).toBeGreaterThan(0.5);
      expect(l.halo).toBeGreaterThan(0);
      expect(l.halo).toBeLessThan(0.5);
    }
  });

  it('keeps a pick or a drag inside the lot', () => {
    expect(worldToBay(-50, -50, lot)).toEqual({ col: 0, row: 0 });
    expect(worldToBay(1e6, 1e6, lot)).toEqual({ col: 9, row: 1 });
    expect(clampToLot(-50, -50, lot)).toEqual(bayToWorld({ col: 0, row: 0 }, lot));
    expect(clampToLot(1e6, 1e6, lot)).toEqual(bayToWorld({ col: 9, row: 1 }, lot));
  });

  it('turns the lot by the facing (clockwise from above)', () => {
    const box = { minX: 0, maxX: 10, minZ: 0, maxZ: 4 };
    const turned = rotateBox(box, Math.PI / 2);
    expect(turned.minX).toBeCloseTo(0);
    expect(turned.maxX).toBeCloseTo(4);
    expect(turned.minZ).toBeCloseTo(-10);
    expect(turned.maxZ).toBeCloseTo(0);
  });

  it('frames the lot and everything outside it', () => {
    expect(sceneBox(lot, [])).toEqual({ minX: 0, maxX: lot.width, minZ: 0, maxZ: lot.depth });
    const withTransformer = sceneBox(lot, [{ x: 40, z: 3 }]);
    expect(withTransformer.maxX).toBe(42);
    const fit = fitFrame(withTransformer, 2);
    expect(fit.target.x).toBe(21);
    expect(fit.distance).toBeLessThan(80);
    expect(maxZoomDistance(withTransformer)).toBeGreaterThanOrEqual(MAX_DISTANCE_MIN);
  });

  it('paints the grass under the whole view at every zoom, wherever the camera looks', () => {
    const frame = sceneBox(lot, []);
    const pan = panBox(frame);
    const g = groundBox(frame, pan);
    for (const distance of [MIN_DISTANCE, 60, maxZoomDistance(frame)]) {
      const reach = distance + fogRange(distance).far;
      for (const target of [clampTarget(-1e6, -1e6, pan), clampTarget(1e6, 1e6, pan)]) {
        expect(target.x - reach).toBeGreaterThan(g.minX);
        expect(target.x + reach).toBeLessThan(g.maxX);
        expect(target.z - reach).toBeGreaterThan(g.minZ);
        expect(target.z + reach).toBeLessThan(g.maxZ);
      }
    }
  });

  it('fades the ground with the camera distance, clear around the target', () => {
    const near = fogRange(20);
    expect(near.near).toBeGreaterThan(20);
    expect(fogRange(200).far).toBe(near.far * 10);
  });

  it('lets the camera tilt down to just above horizontal for an eye-level view', () => {
    expect(MAX_POLAR_ANGLE).toBeCloseTo((88 * Math.PI) / 180);
    expect(MAX_POLAR_ANGLE).toBeLessThan(Math.PI / 2);
    // Lower than the overview Fit to View and the front camera start.
    const overview = Math.atan2(Math.hypot(0.22, 0.86), 0.62);
    expect(MAX_POLAR_ANGLE).toBeGreaterThan(overview);
  });

  it('keeps the camera at eye height or above after an orbit, zoom or pan', () => {
    expect(MIN_CAMERA_HEIGHT).toBe(1.6);
    expect(clampCameraHeight(40)).toBe(40);
    expect(clampCameraHeight(1.6)).toBe(1.6);
    expect(clampCameraHeight(0.9)).toBe(MIN_CAMERA_HEIGHT);
    expect(clampCameraHeight(-3)).toBe(MIN_CAMERA_HEIGHT);
    expect(clampCameraHeight(Number.NaN)).toBe(MIN_CAMERA_HEIGHT);
    // At the lowest orbit a camera far enough out stays where the orbit put it.
    const distance = 60;
    const y = 0.5 + distance * Math.cos(MAX_POLAR_ANGLE);
    expect(clampCameraHeight(y)).toBe(y);
  });

  it('puts a car in a charging spot, a Reserved sign in a reserved one and a cone in maintenance', () => {
    expect(stationProp('charging')).toBe('car');
    // A reservation has no physical sign: a virtual one.
    expect(stationProp('reserved')).toBeNull();
    expect(virtualSignOf('reserved')).toBe('reserved');
    expect(virtualSignOf('maintenance')).toBe('maintenance');
    expect(virtualSignOf('charging')).toBeNull();
    expect(virtualSignOf('available')).toBeNull();
    expect(stationProp('maintenance')).toBe('cone');
    for (const state of ['faulted', 'unavailable', 'offline', 'available', 'online'] as const) {
      expect(stationProp(state)).toBeNull();
    }
  });

  it('fits a logo inside the back panel with padding, never stretched', () => {
    const panel = { width: 0.62, height: 0.62 };
    const wide = logoFit(panel, { width: 400, height: 100 }, 0.04);
    expect(wide.width).toBeCloseTo(0.54);
    expect(wide.height).toBeCloseTo(0.135);
    const tall = logoFit(panel, { width: 100, height: 300 }, 0.04);
    expect(tall.height).toBeCloseTo(0.54);
    expect(tall.width / tall.height).toBeCloseTo(1 / 3);
    expect(logoFit(panel, { width: 0, height: 0 }, 0.04)).toEqual({ width: 0, height: 0 });
  });

  it('gives every charger model a logo panel the scene builds when a logo is set', () => {
    const models: ChargerLogoModel[] = [
      'dc',
      'ac',
      'wall',
      'truck_mcs',
      'bus_dispenser',
      'pantograph_down',
      'pantograph_up',
    ];
    expect(Object.keys(CHARGER_LOGO_PANELS).sort()).toEqual([...models].sort());
    const scene = sceneSource;
    for (const model of models) {
      const spec = CHARGER_LOGO_PANELS[model];
      // A square logo fits inside with padding.
      const fit = logoFit(spec, { width: 120, height: 120 }, 0.03);
      expect(fit.width, model).toBeGreaterThan(0.1);
      expect(fit.width).toBeLessThanOrEqual(spec.width - 0.06 + 1e-9);
      // Only a wall box shows it on its front (its back is on the wall).
      expect(spec.facing, model).toBe(model === 'wall' ? 1 : -1);
      // The scene builds it for this model.
      const built =
        scene.includes(`logoPanel('${model}'`) ||
        (model.startsWith('pantograph') && scene.includes('logoPanel(model,')) ||
        ((model === 'dc' || model === 'ac') && scene.includes("logoPanel(dc ? 'dc' : 'ac'"));
      expect(built, model).toBe(true);
    }
  });

  it('puts the front camera in front of the chargers at eye height, turned with the facing', () => {
    const box = { minX: 0, maxX: 30, minZ: 0, maxZ: 20 };
    for (const facing of [0, Math.PI / 2, Math.PI, -Math.PI / 4]) {
      const { target, position } = frontCamera(box, facing, 16 / 9);
      // The camera stands along the lot's own +z (the chargers' front), turned by the facing.
      const dx = position.x - target.x;
      const dz = position.z - target.z;
      const along = dx * Math.sin(facing) + dz * Math.cos(facing);
      const across = dx * Math.cos(facing) - dz * Math.sin(facing);
      expect(along).toBeGreaterThan(0);
      expect(Math.abs(across)).toBeLessThan(along * 0.01);
      const polar = Math.atan2(Math.hypot(dx, dz), position.y - target.y);
      // Low across the lot (about 11.5 degrees above the ground), within the lowest orbit.
      expect(polar).toBeGreaterThan((75 * Math.PI) / 180);
      expect(polar).toBeLessThan(MAX_POLAR_ANGLE);
      // It looks at charger height.
      expect(target.y).toBe(FRONT_TARGET_Y);
    }
    // Unturned, it frames the site like Fit to View (centered on the same point).
    const unturned = frontCamera(box, 0, 1).target;
    expect(unturned.x).toBe(fitFrame(box, 1).target.x);
    expect(unturned.z).toBe(fitFrame(box, 1).target.z);
    // The overview offset keeps the Fit to View target.
    expect(frontCamera(box, 0, 1, OVERVIEW_CAMERA_OFFSET).target).toEqual(fitFrame(box, 1).target);
  });

  it('pulses the faulted beacon on and off, and keeps it steady and bright without motion', () => {
    const steady = beaconLevel(null);
    expect(steady.intensity).toBeGreaterThan(0.5);
    const samples = Array.from({ length: 40 }, (_, i) => beaconLevel(i * 0.05).intensity);
    expect(Math.min(...samples)).toBeLessThan(0.3);
    expect(Math.max(...samples)).toBeGreaterThan(1.5);
  });

  it('keeps every fitted logo inside the face of its charger model', () => {
    const logos = [
      { width: 120, height: 120 },
      { width: 400, height: 100 },
      { width: 100, height: 300 },
    ];
    for (const model of Object.keys(CHARGER_LOGO_PANELS) as ChargerLogoModel[]) {
      const panel = CHARGER_LOGO_PANELS[model];
      const face = CHARGER_LOGO_FACES[model];
      // The plate on the face: within its whole width (and the AC models'
      // flat part), within its height, on its plane.
      const half = model === 'ac' || model === 'wall' ? face.flatWidth / 2 : face.width / 2;
      expect(Math.abs(panel.x) + panel.width / 2, model).toBeLessThanOrEqual(half + 1e-9);
      expect(panel.y - panel.height / 2, model).toBeGreaterThanOrEqual(face.minY);
      expect(panel.y + panel.height / 2, model).toBeLessThanOrEqual(face.maxY);
      expect(Math.abs(panel.z - face.z), model).toBeLessThanOrEqual(0.02);
      // The logo inside the plate with padding on every side, its aspect ratio kept.
      for (const image of logos) {
        const box = logoFit(panel, image, 0.03);
        expect(box.width, model).toBeLessThanOrEqual(panel.width - 0.06 + 1e-9);
        expect(box.height, model).toBeLessThanOrEqual(panel.height - 0.06 + 1e-9);
        expect(box.width / box.height).toBeCloseTo(image.width / image.height, 9);
      }
    }
    // The AC pedestal: padding on every side of its flat back, in the upper part of the head.
    const ac = CHARGER_LOGO_PANELS.ac;
    const head = CHARGER_LOGO_FACES.ac;
    expect(head.flatWidth / 2 - ac.width / 2).toBeGreaterThanOrEqual(0.02 - 1e-9);
    expect(head.maxY - (ac.y + ac.height / 2)).toBeGreaterThanOrEqual(0.03);
    expect(ac.y).toBeGreaterThan((head.minY + head.maxY) / 2);
  });

  it('sizes the overhead badges by the world within the clamp', () => {
    // 35 degree field of view over a 900 px stage: 1427 px per meter at 1 m.
    expect(pixelsPerMeter(1, 35, 900)).toBeCloseTo(450 / Math.tan((17.5 * Math.PI) / 180), 6);
    expect(pixelsPerMeter(100, 35, 900)).toBeCloseTo(pixelsPerMeter(1, 35, 900) / 100, 9);
    expect(pixelsPerMeter(0, 35, 900)).toBe(Infinity);
    const { worldM, markerPx, avatarPx, minMarkerPx, minAvatarPx } = OVERHEAD_BADGE;
    // Up close never larger than today's size.
    expect(overheadBadgeScale(1000, markerPx, minMarkerPx)).toBe(1);
    expect(overheadBadgeScale(Infinity, avatarPx, minAvatarPx)).toBe(1);
    // In between: the badge's world size on screen.
    const ppm = 20;
    expect(overheadBadgeScale(ppm, markerPx, minMarkerPx)).toBeCloseTo(
      (worldM * ppm) / markerPx,
      9,
    );
    // Far: the readable minimum, 14 px (marker) and 16 px (avatar).
    expect(overheadBadgeScale(1, markerPx, minMarkerPx) * markerPx).toBeCloseTo(14, 9);
    expect(overheadBadgeScale(1, avatarPx, minAvatarPx) * avatarPx).toBeCloseTo(16, 9);
    // Monotonic: never grows as the camera moves away.
    let last = Infinity;
    for (let d = 5; d <= 600; d += 5) {
      const s = overheadBadgeScale(pixelsPerMeter(d, 35, 900), markerPx, minMarkerPx);
      expect(s).toBeLessThanOrEqual(last);
      expect(s * markerPx).toBeGreaterThanOrEqual(minMarkerPx - 1e-9);
      expect(s * markerPx).toBeLessThanOrEqual(markerPx);
      last = s;
    }
  });

  it('calls the markers crowded when a quarter or more of them overlap another', () => {
    const r = (left: number, top: number) => ({ left, top, right: left + 14, bottom: top + 14 });
    expect(overheadBadgesCrowded([])).toBe(false);
    expect(overheadBadgesCrowded([r(0, 0), r(20, 0), r(0, 20)])).toBe(false);
    expect(overheadBadgesCrowded([r(0, 0), r(14, 0)])).toBe(false);
    expect(overheadBadgesCrowded([r(0, 0), r(40, 0), r(10, 5)])).toBe(true);
    // One back-to-back pair among twelve markers: not crowded.
    const apart = Array.from({ length: 10 }, (_, i) => r(100 + 30 * i, 0));
    expect(overheadBadgesCrowded([...apart, r(0, 0), r(4, 6)])).toBe(false);
    // Half of them overlapping: crowded.
    const piled = Array.from({ length: 6 }, (_, i) => r(5 * i, 0));
    expect(overheadBadgesCrowded([...apart.slice(0, 6), ...piled])).toBe(true);
    expect(CROWDED_MARKER_SHARE).toBe(0.25);
  });

  it('keeps every label on a small site and hides far labels on a large one', () => {
    expect(stationLabelInRange(500, 30, LABEL_CULL_FROM - 1)).toBe(true);
    expect(stationLabelInRange(39, 10, 150)).toBe(true);
    expect(stationLabelInRange(41, 10, 150)).toBe(false);
    expect(stationLabelInRange(130, 100, 150)).toBe(true);
    expect(stationLabelInRange(150, 100, 150)).toBe(false);
  });

  it('maps depot slots to their bus bays and truck lanes and back', () => {
    const settings: SiteLayoutSettings = {
      ...effectiveLayoutSettings(null),
      siteType: 'depot',
      busBays: 3,
      truckLanes: 2,
    };
    const lot = lotOf(settings);
    expect(lot.depot?.bays).toHaveLength(3);
    expect(bayToWorld({ col: 1, row: 0 }, lot)).toEqual({ x: 6.45, z: 0.9 });
    expect(bayTurn({ col: 1, row: 1 }, lot)).toBe(0);
    const lane = spotRect({ col: 1, row: 1 }, lot);
    expect(lane.maxX - lane.minX).toBe(25);
    // A point in a lane finds that lane; one on the drive lane the nearest spot.
    expect(worldToBay((lane.minX + lane.maxX) / 2, (lane.minZ + lane.maxZ) / 2, lot)).toEqual({
      col: 1,
      row: 1,
    });
    expect(worldToBay(2, 6, lot)).toEqual({ col: 0, row: 0 });
    expect(layoutGroundBox(lot)).toEqual(lot.depot?.yard);
    expect(depotStationPlacement({ col: 0, row: 1 }, lot).spotType).toBe('truck_pull_through');
  });
});
