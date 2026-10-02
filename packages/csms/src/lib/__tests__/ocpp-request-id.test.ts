// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { describe, it, expect } from 'vitest';
import { MAX_OCPP_REQUEST_ID, newOcppRequestId } from '../ocpp-request-id.js';

describe('newOcppRequestId', () => {
  it('returns a positive integer that fits a signed 32-bit value', () => {
    for (let i = 0; i < 1000; i++) {
      const id = newOcppRequestId();
      expect(Number.isInteger(id)).toBe(true);
      expect(id).toBeGreaterThanOrEqual(1);
      expect(id).toBeLessThanOrEqual(MAX_OCPP_REQUEST_ID);
    }
  });
});
