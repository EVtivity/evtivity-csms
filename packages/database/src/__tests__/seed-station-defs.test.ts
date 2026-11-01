// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { describe, it, expect } from 'vitest';
import { SPLIT_SYSTEM } from '@evtivity/lib/site-layout';
import { STATION_MODELS } from '../seed-station-defs.js';

describe('demo station models', () => {
  it('gives three or more EVSEs only to a DC split system product', () => {
    for (const m of STATION_MODELS) {
      const outputs = m.outputs ?? 2;
      if (outputs < SPLIT_SYSTEM.minDispensers) continue;
      // A split system: a DC power unit feeding up to 8 satellites.
      expect(m.type, m.model).toBe('CCS1');
      expect(m.power, m.model).toBeGreaterThanOrEqual(150);
      expect(outputs, m.model).toBeLessThanOrEqual(SPLIT_SYSTEM.maxDispensers);
    }
    expect(STATION_MODELS.some((m) => (m.outputs ?? 2) >= SPLIT_SYSTEM.minDispensers)).toBe(true);
  });
});
