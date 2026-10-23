// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

// Every event family published on csms_events has a read permission or is
// listed as open on purpose. The operator
// SSE stream refuses an event of a family in neither list, so a new family
// fails here until it is mapped.

import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, it, expect } from 'vitest';
import {
  OPEN_EVENT_FAMILIES,
  eventReadPermission,
  isEventPermitted,
  mappedEventFamilies,
} from '../routes/events.js';

const PACKAGES = fileURLToPath(new URL('../../../', import.meta.url));
const SKIP = new Set(['node_modules', 'dist', '__tests__', '__integration__', 'generated']);
const PATTERNS = [
  /(?:eventType|type)\s*:\s*['`]([a-z][A-Za-z]*)\.[A-Za-z]/g,
  /notifyChange\(\s*['`]([a-z][A-Za-z]*)\.[A-Za-z]/g,
];

/** The event families named in the source files that publish SSE events. */
function publishedFamilies(): Map<string, string> {
  const families = new Map<string, string>();
  const walk = (dir: string): void => {
    for (const name of readdirSync(dir)) {
      if (SKIP.has(name)) continue;
      const path = join(dir, name);
      if (statSync(path).isDirectory()) {
        walk(path);
        continue;
      }
      if (!path.endsWith('.ts') || path.endsWith('.test.ts')) continue;
      const source = readFileSync(path, 'utf8');
      if (!source.includes("'csms_events'") && !source.includes('notifyChange(')) continue;
      for (const pattern of PATTERNS) {
        for (const match of source.matchAll(pattern)) {
          const family = match[1] as string;
          if (!families.has(family)) families.set(family, path.slice(PACKAGES.length));
        }
      }
    }
  };
  for (const pkg of readdirSync(PACKAGES)) {
    const src = join(PACKAGES, pkg, 'src');
    try {
      if (statSync(src).isDirectory()) walk(src);
    } catch {
      // fail-open: a package without a src folder publishes nothing
    }
  }
  return families;
}

describe('SSE event families', () => {
  it('maps every published family to a read permission or lists it as open', () => {
    const known = new Set([...mappedEventFamilies(), ...OPEN_EVENT_FAMILIES]);
    const families = publishedFamilies();
    expect(families.size).toBeGreaterThan(10);
    const missing = [...families].filter(([family]) => !known.has(family));
    expect(missing).toEqual([]);
  });

  it('refuses an event of an unknown family and delivers an open one', () => {
    expect(eventReadPermission('futureFamily.changed')).toBe(false);
    expect(isEventPermitted(['stations:read'], { eventType: 'futureFamily.changed' })).toBe(false);
    expect(isEventPermitted([], { eventType: 'payment.settled' })).toBe(true);
    expect(isEventPermitted(['stations:read'], { eventType: 'station.status' })).toBe(true);
    expect(isEventPermitted([], { eventType: 'station.status' })).toBe(false);
  });
});
