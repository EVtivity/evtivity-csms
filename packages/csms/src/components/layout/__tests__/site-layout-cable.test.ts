// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { describe, it, expect } from 'vitest';
import { sceneSource } from './helpers/scene-source';
import {
  CAR_PORTS,
  CHARGE_FLOW,
  CHARGE_FLOW_STOPS,
  chargeFlowCoreRadius,
  carPortInStation,
  carPortLocal,
  carPortOf,
  parksBackedIn,
  chargeFlowOffset,
  chargeFlowRepeat,
  connectorFlows,
  evseFlows,
} from '../site-layout-cable';
import { STATUS_COLORS } from '@/lib/chart-theme';
import { CAR_BODY_TYPES, CAR_PROFILES } from '../site-layout-car';
import { DC_BOLLARD, DC_CAR_FRONT_M, DC_CAR_TAIL_M } from '../site-layout-dc-bollards';
import { EQUIPMENT_BOLLARD } from '../site-layout-links';

describe('charging cable flow', () => {
  it('flows only while a connector delivers energy', () => {
    expect(connectorFlows('charging')).toBe(true);
    expect(connectorFlows('discharging')).toBe(true);
    for (const status of [
      'suspended_ev',
      'suspended_evse',
      'idle',
      'occupied',
      'available',
      null,
    ]) {
      expect(connectorFlows(status)).toBe(false);
    }
    expect(evseFlows({ connectors: [{ status: 'occupied' }, { status: 'charging' }] })).toBe(true);
    expect(evseFlows({ connectors: [{ status: 'suspended_ev' }] })).toBe(false);
  });

  it('is green in the charging state color and moves from the charger toward the vehicle', () => {
    expect(CHARGE_FLOW.color).toBe(STATUS_COLORS.charging);
    // The tube's u runs from the charger end to the port: a falling offset moves the pulses along +u.
    expect(chargeFlowOffset(0)).toBeCloseTo(0, 9);
    expect(chargeFlowOffset(1)).toBeLessThan(chargeFlowOffset(0));
    // One second moves the pulses speedMps meters.
    expect(-chargeFlowOffset(1) * CHARGE_FLOW.pitchM).toBeCloseTo(CHARGE_FLOW.speedMps, 9);
    // Still without motion.
    expect(chargeFlowOffset(null)).toBe(0);
    expect(chargeFlowRepeat(4.5)).toBeCloseTo(4.5 / CHARGE_FLOW.pitchM, 9);
    // Visible from far: a core of at least 18 mm, a 50 mm halo, pulses a third of the pitch.
    expect(chargeFlowCoreRadius(0.006)).toBeCloseTo(0.018, 9);
    expect(chargeFlowCoreRadius(0.02)).toBeCloseTo(0.032, 9);
    expect(CHARGE_FLOW.haloM).toBeGreaterThan(chargeFlowCoreRadius(0.02));
    const bright = CHARGE_FLOW_STOPS.filter(([, a]) => a === 1).map(([t]) => t);
    expect((Math.max(...bright) - Math.min(...bright)) * CHARGE_FLOW.pitchM).toBeCloseTo(0.27, 2);
    expect(chargeFlowRepeat(0.1)).toBe(1);
  });

  it('draws the flow on every vehicle cable and animates it only with motion', () => {
    // The car, dual-port and large vehicle cables all go through chargingCable.
    expect(sceneSource).toMatch(/t\.cable\(s\.kind, look, stall\.x, noseZ, s\.stallFlows/);
    expect(sceneSource.match(/chargingCable\(/g)?.length ?? 0).toBeGreaterThanOrEqual(7);
    expect(sceneSource).toMatch(
      /for \(const tex of chargeFlowTextures\) tex\.offset\.x = flowOffset;/,
    );
    // The animation runs inside the reduced motion guard of the frame loop.
    const loop = sceneSource.slice(sceneSource.indexOf('function loop(now: number)'));
    const guard = loop.indexOf('if (!options.reducedMotion)');
    expect(guard).toBeGreaterThan(-1);
    expect(loop.indexOf('chargeFlowTextures')).toBeGreaterThan(guard);
  });
});

describe('car charge ports', () => {
  it('gives each car a stable port and uses every real position', () => {
    for (const key of ['ses_1', 'ses_abc', 'sta_x']) {
      expect(carPortOf(key)).toBe(carPortOf(key));
    }
    const seen = new Set(Array.from({ length: 400 }, (_, i) => carPortOf(`ses_${String(i)}`)));
    expect([...seen].sort()).toEqual([...CAR_PORTS].sort());
  });

  it('backs in a car whose port is at the rear, so the port is next to the charger', () => {
    expect(parksBackedIn('rear_left')).toBe(true);
    expect(parksBackedIn('rear_right')).toBe(true);
    for (const port of ['front_left', 'front_right', 'front_center', undefined] as const) {
      expect(parksBackedIn(port)).toBe(false);
    }
    for (const bodyType of CAR_BODY_TYPES) {
      const profile = CAR_PROFILES[bodyType];
      for (const port of CAR_PORTS) {
        // The end toward the charger 0.7 m in front of it: the port within 1.5 m of the charger end.
        const at = carPortInStation(profile, port, { x: 0, z: 0.7 });
        expect(at.z - 0.7, `${bodyType} ${port}`).toBeLessThan(0.7);
        expect(at.z, `${bodyType} ${port}`).toBeGreaterThan(0.6);
        // Side ports stand on the car's side, a nose port on its middle.
        if (port === 'front_center') expect(at.x).toBe(0);
        else expect(Math.abs(at.x)).toBeCloseTo(profile.width / 2 + 0.005, 9);
      }
      // A backed-in car turned a half turn: its left side port faces +x.
      expect(carPortInStation(profile, 'rear_left', { x: 0, z: 0 }).x).toBeGreaterThan(0);
      expect(carPortLocal(profile, 'rear_left').z).toBeCloseTo(profile.length - 0.62, 9);
    }
  });
});

describe('a car at a DC dispenser', () => {
  it('stops nose in 0.3 m clear of the bollards, backed in 36 in past them (Access Board Figure B2)', () => {
    expect(DC_CAR_FRONT_M).toBeCloseTo(DC_BOLLARD.z + EQUIPMENT_BOLLARD.radiusM + 0.3, 9);
    expect(DC_CAR_TAIL_M).toBeCloseTo(DC_BOLLARD.z + EQUIPMENT_BOLLARD.radiusM + 0.9144, 9);
    expect(sceneSource).toMatch(
      /return parksBackedIn\(carLookPort\(look\)\) \? DC_CAR_TAIL_M : DC_CAR_FRONT_M;/,
    );
    expect(sceneSource.match(/carFrontWithoutStop\(s, look\)/g)?.length).toBe(2);
  });
});
