// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { describe, expect, it } from 'vitest';
import { chargerRowKey, chargerUnitQuery } from '../station-units';

describe('charger links of station units', () => {
  it('links a unit row to its unit and a station row as before', () => {
    expect(chargerUnitQuery('unt_box3')).toBe('?unit=unt_box3');
    expect(chargerUnitQuery(null)).toBe('');
    expect(chargerUnitQuery(undefined)).toBe('');
  });

  it('keys rows of one station apart by unit', () => {
    expect(chargerRowKey('EM4', 'unt_box1')).not.toBe(chargerRowKey('EM4', 'unt_box2'));
    expect(chargerRowKey('EM4', null)).toBe('EM4#');
  });
});
