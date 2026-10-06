// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { describe, it, expect } from 'vitest';
import i18n, { loadLanguage } from '../index';

describe('i18n document language', () => {
  it('sets the html lang attribute to the UI language', async () => {
    await loadLanguage('de');
    expect(document.documentElement.lang).toBe('de');
    await loadLanguage('zh-TW');
    expect(document.documentElement.lang).toBe('zh-TW');
    await loadLanguage('en');
    expect(document.documentElement.lang).toBe('en');
    expect(i18n.language).toBe('en');
  });
});
