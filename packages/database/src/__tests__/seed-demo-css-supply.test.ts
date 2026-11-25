// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { describe, expect, it } from 'vitest';
import {
  correctedCssSupply,
  earlierDemoCssSupply,
  isDemoCssStationId,
} from '../seed-demo-css-supply.js';

const row = (over: Partial<Parameters<typeof correctedCssSupply>[0]>) => ({
  stationId: 'CS-0003',
  country: 'US',
  connectorType: 'ac_type1' as const,
  phases: 3,
  voltage: 230,
  ...over,
});

describe('isDemoCssStationId', () => {
  it('covers the base and layout demo stations only', () => {
    expect(isDemoCssStationId('CS-0003')).toBe(true);
    expect(isDemoCssStationId('CS-2004')).toBe(true);
    expect(isDemoCssStationId('CS-3061')).toBe(true);
    expect(isDemoCssStationId('CS-0001')).toBe(false);
    expect(isDemoCssStationId('CS-0002')).toBe(false);
    expect(isDemoCssStationId('CS-9001')).toBe(false);
    expect(isDemoCssStationId('CS-4001')).toBe(false);
    expect(isDemoCssStationId('EM4-MASTER-01')).toBe(false);
  });
});

describe('correctedCssSupply', () => {
  it('moves North American AC off an earlier seeded supply to one 208 V phase', () => {
    expect(correctedCssSupply(row({}))).toEqual({ phases: 1, voltage: 208 });
    expect(correctedCssSupply(row({ stationId: 'CS-2004', phases: 1, voltage: 240 }))).toEqual({
      phases: 1,
      voltage: 208,
    });
  });

  it('keeps a 1 x 240 V supply an operator set on any station but the free vend 1.6 one', () => {
    expect(correctedCssSupply(row({ stationId: 'CS-0003', phases: 1, voltage: 240 }))).toBeNull();
    expect(correctedCssSupply(row({ stationId: 'CS-2003', phases: 1, voltage: 240 }))).toBeNull();
    expect(correctedCssSupply(row({ stationId: 'CS-3001', phases: 1, voltage: 240 }))).toBeNull();
  });

  it('matches only the value the earlier seed wrote for the station and connector', () => {
    expect(earlierDemoCssSupply('CS-0003', 'ac_type1')).toEqual({ phases: 3, voltage: 230 });
    expect(earlierDemoCssSupply('CS-2004', 'ac_type1')).toEqual({ phases: 1, voltage: 240 });
    expect(earlierDemoCssSupply('CS-3001', 'dc_ccs1')).toEqual({ phases: 3, voltage: 400 });
    expect(earlierDemoCssSupply('CS-3001', 'ac_type1')).toBeNull();
    expect(earlierDemoCssSupply('CS-0001', 'ac_type1')).toBeNull();
    // A layout demo DC charger an operator put on 3 x 230 V keeps it.
    expect(correctedCssSupply(row({ stationId: 'CS-3001', connectorType: 'dc_ccs1' }))).toBeNull();
  });

  it('moves North American DC to 480Y/277 V from 3 x 230 V and 3 x 400 V', () => {
    expect(correctedCssSupply(row({ connectorType: 'dc_ccs1' }))).toEqual({
      phases: 3,
      voltage: 277,
    });
    expect(
      correctedCssSupply(row({ stationId: 'CS-3001', connectorType: 'dc_ccs1', voltage: 400 })),
    ).toEqual({
      phases: 3,
      voltage: 277,
    });
  });

  it('keeps an operator supply, a supply already right, a fixture and a European site', () => {
    expect(correctedCssSupply(row({ phases: 1, voltage: 120 }))).toBeNull();
    expect(correctedCssSupply(row({ phases: 1, voltage: 208 }))).toBeNull();
    expect(correctedCssSupply(row({ stationId: 'CS-0001' }))).toBeNull();
    expect(correctedCssSupply(row({ country: 'DE', connectorType: 'ac_type2' }))).toBeNull();
  });
});
