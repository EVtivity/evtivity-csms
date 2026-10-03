// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { describe, it, expect, vi, afterEach } from 'vitest';
import { MAX_OCPP_REQUEST_ID, newOcppRequestId } from '../ocpp-request-id.js';

describe('newOcppRequestId', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('returns a positive integer that fits a signed 32-bit value', () => {
    for (let i = 0; i < 1000; i++) {
      const id = newOcppRequestId();
      expect(Number.isInteger(id)).toBe(true);
      expect(id).toBeGreaterThanOrEqual(1);
      expect(id).toBeLessThanOrEqual(MAX_OCPP_REQUEST_ID);
    }
  });

  function mockRandom(values: number[]): void {
    let call = 0;
    vi.spyOn(crypto, 'getRandomValues').mockImplementation(
      <T extends ArrayBufferView | null>(array: T): T => {
        (array as unknown as Uint32Array)[0] = values[call++] ?? 0;
        return array;
      },
    );
  }

  it('maps the full 32-bit range onto 1 to 2^31 - 1 without modulo', () => {
    mockRandom([0xffffffff]);
    expect(newOcppRequestId()).toBe(MAX_OCPP_REQUEST_ID);
    mockRandom([2]);
    expect(newOcppRequestId()).toBe(1);
  });

  it('draws again when the value would be 0', () => {
    mockRandom([0, 1, 6]);
    expect(newOcppRequestId()).toBe(3);
    expect(crypto.getRandomValues).toHaveBeenCalledTimes(3);
  });
});
