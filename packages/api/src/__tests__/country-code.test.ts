// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { describe, it, expect } from 'vitest';
import { countryToAlpha2 } from '../lib/country-code.js';

describe('countryToAlpha2', () => {
  it('accepts alpha-2 codes in any case', () => {
    expect(countryToAlpha2('US')).toBe('US');
    expect(countryToAlpha2(' de ')).toBe('DE');
  });

  it('maps an alias code to the current one', () => {
    expect(countryToAlpha2('UK')).toBe('GB');
  });

  it('maps English country names', () => {
    expect(countryToAlpha2('United States')).toBe('US');
    expect(countryToAlpha2('germany')).toBe('DE');
    expect(countryToAlpha2('United Kingdom')).toBe('GB');
  });

  it('returns null for empty, unknown and non-country values', () => {
    expect(countryToAlpha2(null)).toBeNull();
    expect(countryToAlpha2('')).toBeNull();
    expect(countryToAlpha2('QQ')).toBeNull();
    expect(countryToAlpha2('EU')).toBeNull();
    expect(countryToAlpha2('European Union')).toBeNull();
    expect(countryToAlpha2('Atlantis')).toBeNull();
  });
});
