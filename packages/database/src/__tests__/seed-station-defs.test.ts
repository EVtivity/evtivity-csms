// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { describe, it, expect } from 'vitest';
import { OCPP_PROTOCOLS } from '@evtivity/lib/ocpp-version';
import {
  DEV_OCPP201_STATION_ID,
  configTemplateVersion,
  demoStationProtocol,
  devStationDefs,
} from '../seed-station-defs.js';

const demoIndexes = Array.from({ length: 2000 }, (_, i) => i);

describe('demo station protocols', () => {
  it('mixes 1.6, 2.0.1 and 2.1 stations', () => {
    const counts = new Map<string, number>();
    for (const i of demoIndexes) {
      const p = demoStationProtocol(i);
      counts.set(p, (counts.get(p) ?? 0) + 1);
    }
    expect(Object.fromEntries(counts)).toEqual({
      'ocpp2.0.1': 334,
      'ocpp2.1': 666,
      'ocpp1.6': 1000,
    });
  });

  it('keeps the first demo station CS-0003 on 2.0.1 and 1.6 from index 1000', () => {
    expect(demoStationProtocol(0)).toBe('ocpp2.0.1');
    expect(demoStationProtocol(1)).toBe('ocpp2.1');
    expect(demoStationProtocol(999)).toBe('ocpp2.0.1');
    expect(demoStationProtocol(1000)).toBe('ocpp1.6');
    expect(demoStationProtocol(1999)).toBe('ocpp1.6');
  });

  it('puts 2.0.1 stations in every 2.x security profile band', () => {
    const bands: Array<[number, number]> = [
      [0, 200],
      [200, 900],
      [900, 950],
      [950, 1000],
    ];
    for (const [from, to] of bands) {
      const protocols = new Set(demoIndexes.slice(from, to).map(demoStationProtocol));
      expect([...protocols].sort(), `${String(from)}-${String(to)}`).toEqual([
        'ocpp2.0.1',
        'ocpp2.1',
      ]);
    }
  });
});

describe('configTemplateVersion', () => {
  it('gives every 2.x station a 2.1 template', () => {
    expect(OCPP_PROTOCOLS.map(configTemplateVersion)).toEqual(['1.6', '2.1', '2.1']);
  });
});

describe('dev fixture stations', () => {
  const defs = devStationDefs({ ioCharger: 'vnd_io', evtivity: 'vnd_evt' });

  it('has one simulator per OCPP version', () => {
    const simulators = defs.filter((d) => d.isSimulator);
    expect(simulators.map((d) => [d.stationId, d.ocppProtocol])).toEqual([
      ['CS-0001', 'ocpp1.6'],
      ['CS-0002', 'ocpp2.1'],
      [DEV_OCPP201_STATION_ID, 'ocpp2.0.1'],
    ]);
  });

  it('adds an AC 2.0.1 simulator outside the demo station range', () => {
    const def = defs.find((d) => d.stationId === DEV_OCPP201_STATION_ID);
    expect(def).toEqual({
      stationId: 'CS-9001',
      vendorId: 'vnd_evt',
      model: 'AC 2.0.1',
      serialNumber: 'SN-2026-9001',
      ocppProtocol: 'ocpp2.0.1',
      isSimulator: true,
      connector: { type: 'Type2', power: '22', amps: 32 },
    });
    // CS-0003..CS-2002 are the demo stations, and CS-0003 marks a seeded demo.
    const n = Number(DEV_OCPP201_STATION_ID.slice(3));
    expect(n < 3 || n > 2002).toBe(true);
    expect(new Set(defs.map((d) => d.stationId)).size).toBe(defs.length);
  });
});
