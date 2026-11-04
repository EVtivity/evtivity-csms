// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { describe, it, expect } from 'vitest';
import { chargingNeedsProfileId } from '../charging-profile-ids.js';

describe('chargingNeedsProfileId', () => {
  it('is stable per transaction and in the upper int32 range', () => {
    const id = chargingNeedsProfileId('CS-1', 'tx-1');
    expect(chargingNeedsProfileId('CS-1', 'tx-1')).toBe(id);
    expect(chargingNeedsProfileId('CS-1', 'tx-2')).not.toBe(id);
    expect(chargingNeedsProfileId('CS-2', 'tx-1')).not.toBe(id);
    expect(id).toBeGreaterThanOrEqual(0x40000000);
    expect(id).toBeLessThanOrEqual(0x7fffffff);
  });
});
