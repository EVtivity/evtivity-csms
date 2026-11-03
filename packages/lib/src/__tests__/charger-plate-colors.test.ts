// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { describe, it, expect } from 'vitest';
import {
  DEFAULT_THEME_COLOR,
  isChargerPlateColorKey,
  normalizeChargerPlateColor,
  resolveBrandColor,
  resolveChargerPlateColor,
} from '../charger-plate-colors.js';

describe('charger plate colors', () => {
  it('names the AC and DC keys only', () => {
    expect(isChargerPlateColorKey('company.chargerColorAc')).toBe(true);
    expect(isChargerPlateColorKey('company.chargerColorDc')).toBe(true);
    expect(isChargerPlateColorKey('company.themeColor')).toBe(false);
  });

  it('stores empty or a lowercase #rrggbb color', () => {
    expect(normalizeChargerPlateColor('')).toBe('');
    expect(normalizeChargerPlateColor('  ')).toBe('');
    expect(normalizeChargerPlateColor(' #A1B2C3 ')).toBe('#a1b2c3');
    for (const bad of ['#abc', 'a1b2c3', '#a1b2c3d4', 'red', '#gggggg', 123, null, true]) {
      expect(normalizeChargerPlateColor(bad)).toBeNull();
    }
  });

  it('falls back to the theme color, then the default', () => {
    expect(resolveChargerPlateColor('', '#112233')).toBe('#112233');
    expect(resolveChargerPlateColor(undefined, '#112233')).toBe('#112233');
    expect(resolveChargerPlateColor('#445566', '#112233')).toBe('#445566');
    expect(resolveChargerPlateColor('', '')).toBe(DEFAULT_THEME_COLOR);
    expect(resolveChargerPlateColor('', 'blue')).toBe(DEFAULT_THEME_COLOR);
    expect(resolveChargerPlateColor('nope', '#112233')).toBe('#112233');
    expect(resolveBrandColor('#AABBCC')).toBe('#aabbcc');
  });
});
