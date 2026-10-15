// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { describe, it, expect } from 'vitest';
import { MAX_GUEST_VELOCITY_LIMIT, parseGuestVelocityLimit } from '../lib/guest-setting.js';

describe('parseGuestVelocityLimit', () => {
  it('accepts whole numbers from 0 (no limit) to the maximum', () => {
    expect(parseGuestVelocityLimit(0)).toBe(0);
    expect(parseGuestVelocityLimit(30)).toBe(30);
    expect(parseGuestVelocityLimit(MAX_GUEST_VELOCITY_LIMIT)).toBe(MAX_GUEST_VELOCITY_LIMIT);
  });

  it('refuses negatives, fractions, too large values and non-numbers', () => {
    for (const value of [-1, 1.5, MAX_GUEST_VELOCITY_LIMIT + 1, '30', null, undefined, true]) {
      expect(parseGuestVelocityLimit(value)).toBeNull();
    }
  });
});
