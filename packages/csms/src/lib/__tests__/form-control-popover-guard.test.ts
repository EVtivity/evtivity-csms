// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { describe, expect, it } from 'vitest';

/**
 * Pickers come from the shared components (`frontend/ui.md`, shared
 * controls). A search or option list under a field is the shared `Combobox`
 * or `SearchCombobox`, never a hand-built popover layer: those had no
 * keyboard support and no listbox roles. ESLint `evtivity/no-raw-form-control`
 * refuses raw inputs, native pickers and hand-built listbox roles; this guard
 * catches the popover layer itself (`absolute` or `fixed` with `bg-popover`)
 * in every CSMS and portal source file outside `components/ui`.
 */

const CSMS_SOURCES = import.meta.glob<string>(
  ['../../**/*.tsx', '!**/__tests__/**', '!../../components/ui/**'],
  { query: '?raw', import: 'default', eager: true },
);
const PORTAL_SOURCES = import.meta.glob<string>(
  [
    '../../../../portal/src/**/*.tsx',
    '!**/__tests__/**',
    '!../../../../portal/src/components/ui/**',
  ],
  { query: '?raw', import: 'default', eager: true },
);

/** Popover layers that are not a field's picker, each with the reason. */
const ALLOWED: Record<string, string> = {
  '../../components/SpeedDial.tsx': 'action menu of a floating button, not a form control',
  '../../components/ColumnVisibilityToggle.tsx':
    'the shared column menu (frontend/ui.md), a list of shared Checkbox controls',
  '../../components/FilterBar.tsx':
    'the shared FilterPopover (frontend/ui.md), a panel of shared controls',
  '../../pages/Dashboard.tsx':
    'the Historical range panel, which holds the shared DateRangeControl date fields',
  '../../components/layout/StationCard.tsx': 'a hover tooltip, not a form control',
};

// A class string (in className or cn()) with a positioned popover surface.
const POPOVER_LAYER = /["'`][^"'`\n]*\b(?:absolute|fixed)\b[^"'`\n]*\bbg-popover\b/;

describe('no hand-built picker popovers', () => {
  it('scans the CSMS and portal sources', () => {
    expect(Object.keys(CSMS_SOURCES).length).toBeGreaterThan(200);
    expect(Object.keys(PORTAL_SOURCES).length).toBeGreaterThan(30);
  });

  it('renders popover layers only in the shared components and the allowed files', () => {
    const offenders = Object.entries({ ...CSMS_SOURCES, ...PORTAL_SOURCES })
      .filter(([file]) => !(file in ALLOWED))
      .filter(([, src]) => POPOVER_LAYER.test(src))
      .map(([file]) => file);
    expect(offenders).toEqual([]);
  });

  it('allows only files that exist and still have a popover layer', () => {
    for (const file of Object.keys(ALLOWED)) {
      const src = CSMS_SOURCES[file];
      expect(src, file).toBeDefined();
      expect(POPOVER_LAYER.test(src ?? ''), file).toBe(true);
    }
  });
});
