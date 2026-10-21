// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { describe, expect, it } from 'vitest';
import { normalizedPhone, phoneToStore, readPhoneInput } from '../lib/phone-input.js';

describe('readPhoneInput', () => {
  it('keeps every spelling of a number in one E.164 form', () => {
    expect(readPhoneInput('+1 (201) 555-0123')).toEqual({ kind: 'number', phone: '+12015550123' });
    expect(readPhoneInput('201 555 0123')).toEqual({ kind: 'number', phone: '+12015550123' });
  });

  it('tells a removal, a missing field and an invalid number apart', () => {
    expect(readPhoneInput(undefined)).toEqual({ kind: 'absent' });
    expect(readPhoneInput(null)).toEqual({ kind: 'none' });
    expect(readPhoneInput('  ')).toEqual({ kind: 'none' });
    expect(readPhoneInput('555-0100')).toEqual({ kind: 'invalid' });
    expect(phoneToStore({ kind: 'absent' })).toBeUndefined();
    expect(phoneToStore({ kind: 'none' })).toBeNull();
  });
});

describe('normalizedPhone', () => {
  it('compares a stored row in E.164, and keeps one that does not parse as it is', () => {
    expect(normalizedPhone('(201) 555-0123')).toBe('+12015550123');
    expect(normalizedPhone(' 555-0100 ')).toBe('555-0100');
    expect(normalizedPhone('')).toBeNull();
  });
});
