// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { describe, it, expect } from 'vitest';

/**
 * Turning a Settings switch off asks for confirmation (owner decision
 * 2026-10-27, `frontend/ui.md`, "Clean, user-friendly settings and forms").
 * Every switch on the Settings page, its tabs and the cards they render is the
 * shared `ConfirmToggle`, never the raw `Toggle`. This scans those sources and
 * fails on a raw `Toggle` import or element.
 */

// The Settings page, every settings card, and the pages Settings shows as tabs.
const SETTINGS_SOURCES = import.meta.glob<string>(
  [
    '../../pages/Settings*.tsx',
    '../../pages/FirmwareCampaigns.tsx',
    '../../pages/ConfigTemplates.tsx',
    '../../pages/SmartChargingTemplates.tsx',
    '../../pages/Conformance.tsx',
    '../../components/settings/**/*.tsx',
    '!**/__tests__/**',
  ],
  { query: '?raw', import: 'default', eager: true },
);

/**
 * Files allowed to render the raw `Toggle`, each with the reason. Empty: every
 * Settings switch confirms when turned off.
 */
const ALLOWED: Record<string, string> = {};

const RAW_TOGGLE_IMPORT = /from\s+['"]@\/components\/ui\/toggle['"]/;
const RAW_TOGGLE_ELEMENT = /<Toggle[\s/>]/;

describe('Settings switches confirm before turning off', () => {
  it('scans the Settings sources', () => {
    const files = Object.keys(SETTINGS_SOURCES);
    expect(files.some((f) => f.endsWith('pages/Settings.tsx'))).toBe(true);
    expect(files.some((f) => f.endsWith('components/settings/AiOpsSettings.tsx'))).toBe(true);
    expect(files.length).toBeGreaterThan(30);
  });

  it('renders ConfirmToggle, never the raw Toggle', () => {
    const offenders = Object.entries(SETTINGS_SOURCES)
      .filter(([file]) => !(file in ALLOWED))
      .filter(([, src]) => RAW_TOGGLE_IMPORT.test(src) || RAW_TOGGLE_ELEMENT.test(src))
      .map(([file]) => file);
    expect(offenders).toEqual([]);
  });

  it('allows only files that exist', () => {
    for (const file of Object.keys(ALLOWED)) {
      expect(SETTINGS_SOURCES[file]).toBeDefined();
    }
  });
});
