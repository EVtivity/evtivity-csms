// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { describe, it, expect } from 'vitest';
import { isNewOcpiToken, ocpiTokenTypeOf } from '../ocpi-token-types.js';

describe('ocpiTokenTypeOf', () => {
  it.each([
    ['ISO14443', 'RFID'],
    ['ISO15693', 'RFID'],
    ['eMAID', 'APP_USER'],
    ['DirectPayment', 'AD_HOC_USER'],
    ['KeyCode', 'OTHER'],
    ['Unknown', 'RFID'],
  ])('maps %s to %s', (driverType, ocpiType) => {
    expect(ocpiTokenTypeOf(driverType)).toBe(ocpiType);
  });
});

describe('isNewOcpiToken', () => {
  it('is the same OCPI Token from ISO14443 to ISO15693', () => {
    expect(
      isNewOcpiToken(
        { idToken: 'A1', tokenType: 'ISO14443' },
        { idToken: 'A1', tokenType: 'ISO15693' },
      ),
    ).toBe(false);
  });

  it('is a new OCPI Token when the OCPI type or the uid changes', () => {
    expect(
      isNewOcpiToken(
        { idToken: 'A1', tokenType: 'ISO14443' },
        { idToken: 'A1', tokenType: 'eMAID' },
      ),
    ).toBe(true);
    expect(
      isNewOcpiToken(
        { idToken: 'A1', tokenType: 'ISO14443' },
        { idToken: 'A2', tokenType: 'ISO14443' },
      ),
    ).toBe(true);
  });
});
