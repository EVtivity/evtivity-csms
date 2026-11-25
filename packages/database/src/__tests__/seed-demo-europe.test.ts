// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { describe, expect, it } from 'vitest';
import { computeMaxContinuousKw } from '@evtivity/lib';
import {
  EU_DC,
  EU_TRANSFORMER_KVA,
  EUROPE_DEMO,
  europeBoardKw,
  europeCircuitKw,
} from '../seed-demo-europe.js';

// The European demo site follows its own electrical rules: each charger on
// a circuit that carries it, the board within 80 percent of its rating, the
// transformer at least the connected load, the phases balanced.

const ac = EUROPE_DEMO.stations.filter((s) => s.connectorType === 'Type2');

describe('European demo site', () => {
  it('has three-phase 22 and 11 kW, single-phase 7.4 kW and a DC charger', () => {
    const kinds = EUROPE_DEMO.stations.map(
      (s) =>
        `${s.connectorType} ${String(s.supply.phases)}x${String(s.supply.voltage)} ${String(s.kw)}`,
    );
    expect(kinds).toEqual([
      'Type2 3x230 22',
      'Type2 3x230 22',
      'Type2 3x230 11',
      'Type2 3x230 11',
      'Type2 1x230 7.36',
      'Type2 1x230 7.36',
      'CCS2 3x230 150',
    ]);
    expect(new Set(EUROPE_DEMO.stations.map((s) => s.ocppProtocol))).toEqual(
      new Set(['ocpp1.6', 'ocpp2.0.1', 'ocpp2.1']),
    );
  });

  it('puts every AC charger on a circuit that carries its current at the 80 percent rule', () => {
    for (const s of ac) {
      const power = s.amps * s.supply.voltage * s.supply.phases;
      expect(s.kw * 1000, s.stationId).toBeLessThanOrEqual(power + 1e-9);
      expect(europeCircuitKw(s) * 1000, s.stationId).toBeGreaterThanOrEqual(power - 1e-9);
      expect(s.circuit.breakerAmps * 0.8, s.stationId).toBeGreaterThanOrEqual(s.amps);
    }
  });

  it('puts the DC charger on a breaker of at least 125 percent of its derived input current', () => {
    const inputA = (EU_DC.inputKva * 1000) / (Math.sqrt(3) * 400);
    expect(EU_DC.breakerAmps).toBeGreaterThanOrEqual(inputA * 1.25);
    const dc = EUROPE_DEMO.stations.find((s) => s.connectorType === 'CCS2');
    expect(europeCircuitKw(dc!)).toBeGreaterThanOrEqual(EU_DC.inputKva * 0.96);
  });

  it('keeps the board under 80 percent of its rating and the transformer at the connected load', () => {
    const acKva = ac.reduce((n, s) => n + (s.amps * s.supply.voltage * s.supply.phases) / 1000, 0);
    const connectedKva = acKva + EU_DC.inputKva;
    const boardRatingKva = (500 * 230 * 3) / 1000;
    expect(connectedKva / boardRatingKva).toBeLessThanOrEqual(0.8);
    expect(europeBoardKw()).toBe(Math.round(computeMaxContinuousKw(500, 230, 3) * 100) / 100);
    expect(EU_TRANSFORMER_KVA).toBeGreaterThanOrEqual(connectedKva);
    // The next smaller rated power of Regulation (EU) 548/2014 would not carry it.
    expect(160).toBeLessThan(connectedKva);
  });

  it('splits the single-phase chargers over two phases and gives two 2.x EVSEs phase switching', () => {
    const single = ac.filter((s) => s.supply.phases === 1);
    expect(single.map((s) => s.circuit.phaseConnections)).toEqual(['L1', 'L2']);
    const switching = EUROPE_DEMO.stations.filter((s) => s.phaseSwitching);
    expect(switching.map((s) => s.stationId)).toEqual(['CS-4001', 'CS-4003']);
    expect(switching.every((s) => s.ocppProtocol !== 'ocpp1.6' && s.supply.phases === 3)).toBe(
      true,
    );
  });
});
