// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { describe, it, expect, vi } from 'vitest';
import { Bell } from 'lucide-react';

vi.hoisted(() => {
  // The auth store reads the color scheme when it loads.
  Object.defineProperty(window, 'matchMedia', {
    value: () => ({
      matches: false,
      addEventListener: () => undefined,
      removeEventListener: () => undefined,
    }),
  });
});

import { NAV_ENTRIES, visibleNavEntries, type NavEntry } from '../registry';

const ALL_ON = {
  roamingEnabled: true,
  pncEnabled: true,
  reservationEnabled: true,
  supportEnabled: true,
  fleetEnabled: true,
};

describe('NAV_ENTRIES', () => {
  it('has unique routes and unique orders, listed in order', () => {
    expect(new Set(NAV_ENTRIES.map((e) => e.to)).size).toBe(NAV_ENTRIES.length);
    const orders = NAV_ENTRIES.map((e) => e.order);
    expect(new Set(orders).size).toBe(orders.length);
    expect(orders).toEqual([...orders].sort((a, b) => a - b));
  });
});

describe('visibleNavEntries', () => {
  it('sorts by order, accepts any permission of a list, and applies isVisible', () => {
    const entries: NavEntry[] = [
      { to: '/b', labelKey: 'nav.logs', icon: Bell, order: 2, requiredPermission: 'logs:read' },
      {
        to: '/a',
        labelKey: 'nav.audit',
        icon: Bell,
        order: 1,
        requiredPermission: ['audit:read', 'users:read'],
      },
      {
        to: '/c',
        labelKey: 'nav.users',
        icon: Bell,
        order: 3,
        requiredPermission: 'users:read',
        isVisible: (flags) => flags.fleetEnabled,
      },
    ];
    expect(
      visibleNavEntries(['users:write', 'logs:read'], ALL_ON, entries).map((e) => e.to),
    ).toEqual(['/a', '/b', '/c']);
    expect(
      visibleNavEntries(['users:read'], { ...ALL_ON, fleetEnabled: false }, entries).map(
        (e) => e.to,
      ),
    ).toEqual(['/a']);
    expect(visibleNavEntries([], ALL_ON, entries)).toEqual([]);
  });
});
