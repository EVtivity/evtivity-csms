// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { describe, it, expect } from 'vitest';
import { CONNECTOR_TYPES, isDcConnector, stationChargingKind } from '../connector-power.js';

describe('isDcConnector', () => {
  it('classifies every connector type at low and high power', () => {
    const expected: Record<string, [boolean, boolean]> = {
      CCS1: [true, true],
      CCS2: [true, true],
      CHAdeMO: [true, true],
      Type1: [false, false],
      Type2: [false, false],
      GBT: [false, true],
      Tesla: [false, true],
      NACS: [false, true],
    };
    for (const type of CONNECTOR_TYPES) {
      const [low, high] = expected[type]!;
      expect(isDcConnector({ connectorType: type, maxPowerKw: 11 })).toBe(low);
      expect(isDcConnector({ connectorType: type, maxPowerKw: 150 })).toBe(high);
    }
  });

  it('draws the line at 22 kW for plugs that carry AC and DC', () => {
    expect(isDcConnector({ connectorType: 'NACS', maxPowerKw: 22 })).toBe(false);
    expect(isDcConnector({ connectorType: 'NACS', maxPowerKw: '22.1' })).toBe(true);
    expect(isDcConnector({ connectorType: 'GBT', maxPowerKw: null })).toBe(false);
  });

  it('treats unknown and missing types as AC', () => {
    expect(isDcConnector({ connectorType: null, maxPowerKw: 350 })).toBe(false);
    expect(isDcConnector({ connectorType: 'Schuko', maxPowerKw: 350 })).toBe(false);
  });
});

describe('stationChargingKind', () => {
  it('is DC when any connector is DC', () => {
    expect(
      stationChargingKind([
        { connectorType: 'Type2', maxPowerKw: 22 },
        { connectorType: 'CCS2', maxPowerKw: 150 },
      ]),
    ).toBe('dc');
    expect(stationChargingKind([{ connectorType: 'Type2', maxPowerKw: 22 }])).toBe('ac');
    expect(stationChargingKind([])).toBe('ac');
  });
});
