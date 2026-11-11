// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { describe, it, expect, afterEach } from 'vitest';
import { adoptUiTheme, applyUiTheme, resolveInitialUiTheme } from '../theme';

afterEach(() => {
  localStorage.clear();
  document.documentElement.removeAttribute('data-theme');
});

describe('CSMS themes', () => {
  it('sets data-theme for a theme other than Default and removes it for Default', () => {
    applyUiTheme('high-contrast');
    expect(document.documentElement.getAttribute('data-theme')).toBe('high-contrast');
    applyUiTheme('default');
    expect(document.documentElement.hasAttribute('data-theme')).toBe(false);
  });

  it('stores the account theme for the pre-paint script and reads unknown values as Default', () => {
    expect(adoptUiTheme('soft')).toBe('soft');
    expect(localStorage.getItem('ui_theme')).toBe('soft');
    expect(resolveInitialUiTheme()).toBe('soft');
    expect(adoptUiTheme(undefined)).toBe('default');
    localStorage.setItem('ui_theme', 'neon');
    expect(resolveInitialUiTheme()).toBe('default');
  });
});
