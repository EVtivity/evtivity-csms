// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { describe, expect, it } from 'vitest';
import { canonicalPhone } from '../phone.js';

describe('canonicalPhone', () => {
  it('gives every spelling of one number the same E.164 form', () => {
    for (const input of [
      '+1 201 555 0123',
      '+1 (201) 555-0123',
      '+12015550123',
      '2015550123',
      '1-201-555-0123',
      ' (201) 555.0123 ',
    ]) {
      expect(canonicalPhone(input)).toBe('+12015550123');
    }
    expect(canonicalPhone('+49 151 23456789')).toBe('+4915123456789');
  });

  it('refuses what is not a valid number', () => {
    for (const input of [
      '',
      '   ',
      '(555) 0100',
      '555-0100',
      '+1 555 0100',
      'call me',
      '+999 123',
    ]) {
      expect(canonicalPhone(input)).toBeNull();
    }
  });
});
