// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { describe, expect, it } from 'vitest';
import { EV_PHASES, phaseCountOf, phasesFromReadings } from '../ev-phases.js';

describe('phasesFromReadings', () => {
  it('names the phases that carry at least 1 A', () => {
    expect(
      phasesFromReadings(
        [
          { phase: 'L1', amps: 15.8 },
          { phase: 'L2', amps: 0.1 },
          { phase: 'L3', amps: 0 },
        ],
        null,
      ),
    ).toBe('L1');
    expect(
      phasesFromReadings(
        [
          { phase: 'L3', amps: 1 },
          { phase: 'L1', amps: 7 },
        ],
        null,
      ),
    ).toBe('L1L3');
  });

  it('reads L1-N style phase names and ignores neutral and line to line samples', () => {
    expect(phasesFromReadings([{ phase: 'L2-N', amps: 10 }], null)).toBe('L2');
    expect(
      phasesFromReadings(
        [
          { phase: 'N', amps: 10 },
          { phase: 'L1-L2', amps: 10 },
        ],
        null,
      ),
    ).toBeNull();
  });

  it('lets readings win over numberOfPhasesUsed', () => {
    expect(phasesFromReadings([{ phase: 'L1', amps: 16 }], 3)).toBe('L1');
  });

  it('takes three phases from numberOfPhasesUsed without a reading over 1 A', () => {
    expect(phasesFromReadings([], 3)).toBe('L1L2L3');
    expect(phasesFromReadings([{ phase: 'L1', amps: 0.2 }], 3)).toBe('L1L2L3');
  });

  it('stays unknown for one or two phases without a reading, and without anything', () => {
    expect(phasesFromReadings([], 1)).toBeNull();
    expect(phasesFromReadings([], 2)).toBeNull();
    expect(phasesFromReadings([], null)).toBeNull();
    expect(phasesFromReadings([{ phase: 'L1', amps: Number.NaN }], null)).toBeNull();
  });

  it('lists only the stored phase sets', () => {
    expect(EV_PHASES).toEqual(['L1', 'L2', 'L3', 'L1L2', 'L1L3', 'L2L3', 'L1L2L3']);
    expect(phaseCountOf('L1L3')).toBe(2);
    expect(phaseCountOf(null)).toBeNull();
    expect(phaseCountOf('x')).toBeNull();
  });
});
