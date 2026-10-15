// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { describe, it, expect } from 'vitest';
import { ISO3166_ALPHA2_TO_ALPHA3, toIso3166Alpha3, isKnownCountry } from '../country.js';

describe('toIso3166Alpha3', () => {
  it('lists every officially assigned ISO 3166-1 code once', () => {
    expect(ISO3166_ALPHA2_TO_ALPHA3.size).toBe(249);
    expect(new Set(ISO3166_ALPHA2_TO_ALPHA3.values()).size).toBe(249);
    for (const [a2, a3] of ISO3166_ALPHA2_TO_ALPHA3) {
      expect(a2).toMatch(/^[A-Z]{2}$/);
      expect(a3).toMatch(/^[A-Z]{3}$/);
    }
  });

  it.each([
    ['US', 'USA'],
    ['us', 'USA'],
    ['USA', 'USA'],
    ['United States', 'USA'],
    ['united states of america', 'USA'],
    [' Germany ', 'DEU'],
    ['DE', 'DEU'],
    ['deu', 'DEU'],
    ['UK', 'GBR'],
    ['United Kingdom', 'GBR'],
    ['Netherlands', 'NLD'],
    ['Côte d’Ivoire', 'CIV'],
    ['South Korea', 'KOR'],
  ])('%j -> %s', (input, expected) => {
    expect(toIso3166Alpha3(input)).toBe(expected);
  });

  it.each([[''], ['   '], ['XX'], ['ZZZ'], ['Atlantis'], [null], [undefined]])(
    '%j is not a country',
    (input) => {
      expect(toIso3166Alpha3(input)).toBeNull();
    },
  );

  it('isKnownCountry follows the conversion', () => {
    expect(isKnownCountry('France')).toBe(true);
    expect(isKnownCountry('Nowhere')).toBe(false);
  });
});
