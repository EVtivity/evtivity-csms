// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { describe, expect, it } from 'vitest';
import { terminalStartEvse } from '../payment-terminal-evse.js';

describe('terminalStartEvse (security case 269)', () => {
  it('starts on the paired EVSE whatever the driver picked', () => {
    expect(terminalStartEvse(2, 1, [1, 2])).toBe(2);
    expect(terminalStartEvse(2, 9, [1, 2])).toBe(2);
  });

  it('takes the pick only when it is an EVSE of the paired station', () => {
    expect(terminalStartEvse(null, 2, [1, 2])).toBe(2);
    // A connector of another station, or one out of service, never counts.
    expect(terminalStartEvse(null, 7, [1, 2])).toBe(0);
  });

  it('falls back to the only EVSE, else lets the station decide (0)', () => {
    expect(terminalStartEvse(null, null, [3])).toBe(3);
    expect(terminalStartEvse(null, 7, [3])).toBe(3);
    expect(terminalStartEvse(null, null, [1, 2])).toBe(0);
    expect(terminalStartEvse(null, null, [])).toBe(0);
  });
});
