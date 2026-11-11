// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { describe, it, expect, afterEach } from 'vitest';
import { adoptUiTheme, applyUiTheme, storedUiTheme } from '../theme';

afterEach(() => {
  localStorage.clear();
  document.documentElement.removeAttribute('data-theme');
});

describe('portal themes', () => {
  it('sets data-theme for a theme other than Default and removes it for Default', () => {
    applyUiTheme('soft');
    expect(document.documentElement.getAttribute('data-theme')).toBe('soft');
    applyUiTheme('default');
    expect(document.documentElement.hasAttribute('data-theme')).toBe(false);
  });

  it('stores the driver theme for the pre-paint script and reads unknown values as Default', () => {
    expect(adoptUiTheme('high-contrast')).toBe('high-contrast');
    expect(localStorage.getItem('portal_ui_theme')).toBe('high-contrast');
    expect(storedUiTheme()).toBe('high-contrast');
    localStorage.setItem('portal_ui_theme', 'system');
    expect(storedUiTheme()).toBe('default');
  });
});
