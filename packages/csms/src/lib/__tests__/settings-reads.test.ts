// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { describe, it, expect } from 'vitest';

// Every CSMS source file except tests.
const SOURCES = import.meta.glob<string>(['../../**/*.{ts,tsx}', '!**/__tests__/**'], {
  query: '?raw',
  import: 'default',
  eager: true,
});

// The settings reads need settings permissions (`settings.system:read` for
// /v1/settings). Only the Settings page and its tabs, which the route guard
// opens to settings readers, may call them. Other pages read the public
// endpoints: /v1/portal/features, /v1/portal/branding, /v1/portal/chargers/map-config.
function isSettingsPage(file: string): boolean {
  return file === '../../pages/Settings.tsx' || file.startsWith('../../components/settings/');
}

const SETTINGS_READ =
  /\bapi\.get\b[^;]*?['"`]\/v1\/(?:settings|pnc\/settings|security\/settings)\b/g;

describe('settings reads in the CSMS', () => {
  it('scans the sources and finds the Settings page reads', () => {
    expect(Object.keys(SOURCES).length).toBeGreaterThan(100);
    const settingsPageReads = Object.entries(SOURCES)
      .filter(([file]) => isSettingsPage(file))
      .flatMap(([, src]) => [...src.matchAll(SETTINGS_READ)]);
    expect(settingsPageReads.length).toBeGreaterThan(0);
  });

  it('reads settings only on the Settings page and its tabs', () => {
    const outside: string[] = [];
    for (const [file, src] of Object.entries(SOURCES)) {
      if (isSettingsPage(file)) continue;
      for (const m of src.matchAll(SETTINGS_READ)) outside.push(`${file}: ${m[0]}`);
    }
    expect(outside).toEqual([]);
  });
});
