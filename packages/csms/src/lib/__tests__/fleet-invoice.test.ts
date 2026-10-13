// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { describe, it, expect } from 'vitest';
import { readBillTo } from '../fleet-invoice';

describe('readBillTo', () => {
  it('reads the fleet bill-to block with its tax ID', () => {
    expect(
      readBillTo({
        name: 'Acme Logistics GmbH',
        street: 'Hafenstr. 1',
        zip: '20457',
        city: 'Hamburg',
        state: null,
        country: 'Germany',
        taxId: 'DE123456789',
      }),
    ).toEqual({
      name: 'Acme Logistics GmbH',
      lines: ['Hafenstr. 1', '20457 Hamburg', 'Germany'],
      taxId: 'DE123456789',
    });
  });

  it('prints the member invoice email after the address, also without an address', () => {
    expect(
      readBillTo({
        name: 'Anna Berg',
        street: 'Lindenweg 3',
        zip: '28195',
        city: 'Bremen',
        country: 'Germany',
        taxId: null,
        email: 'anna@fleet.test',
      }),
    ).toEqual({
      name: 'Anna Berg',
      lines: ['Lindenweg 3', '28195 Bremen', 'Germany', 'anna@fleet.test'],
      taxId: null,
    });
    expect(readBillTo({ name: 'Anna Berg', taxId: null, email: 'anna@fleet.test' })).toEqual({
      name: 'Anna Berg',
      lines: ['anna@fleet.test'],
      taxId: null,
    });
  });

  it('returns null on a driver invoice', () => {
    expect(readBillTo(null)).toBeNull();
    expect(readBillTo({ street: 'x' })).toBeNull();
  });
});
