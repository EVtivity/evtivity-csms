// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { describe, expect, it } from 'vitest';
import {
  isPhaseRotation,
  parseConnectorPhaseRotations,
  parsePhaseRotation,
  phasesThroughRotation,
} from '../phase-rotation.js';

describe('phase rotation', () => {
  it('reads the six wirings and nothing else', () => {
    expect(parsePhaseRotation('rst')).toBe('RST');
    expect(parsePhaseRotation(' TSR ')).toBe('TSR');
    for (const value of ['', 'RSx', 'Unknown', 'NotApplicable', 'RRS', null, undefined]) {
      expect(parsePhaseRotation(value)).toBeNull();
    }
    expect(isPhaseRotation('SRT')).toBe(true);
    expect(isPhaseRotation('srt')).toBe(false);
  });

  it('reads the OCPP 1.6 ConnectorPhaseRotation list by connector', () => {
    expect([...parseConnectorPhaseRotations('0.RST, 1.RTS, 2.Unknown,3.TRS')]).toEqual([
      [0, 'RST'],
      [1, 'RTS'],
      [3, 'TRS'],
    ]);
    expect([...parseConnectorPhaseRotations(null)]).toEqual([]);
  });

  it('maps a component phase to the parent phase its letter names', () => {
    // TRS: L1 on L3, L2 on L1, L3 on L2.
    expect(phasesThroughRotation('L1', 'TRS')).toBe('L3');
    expect(phasesThroughRotation('L2', 'TRS')).toBe('L1');
    expect(phasesThroughRotation('L1L2', 'TRS')).toBe('L1L3');
    expect(phasesThroughRotation('L1L2L3', 'SRT')).toBe('L1L2L3');
    expect(phasesThroughRotation('L2', 'RST')).toBe('L2');
    expect(phasesThroughRotation('L3', 'RTS')).toBe('L2');
  });
});
