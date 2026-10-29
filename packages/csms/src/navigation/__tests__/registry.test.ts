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

import {
  NAV_ENTRIES,
  PAYMENT_TERMINALS_NAV_ENABLED,
  paymentTerminalsNavVisible,
  visibleNavEntries,
  type NavEntry,
} from '../registry';

const ALL_ON = {
  roamingEnabled: true,
  pncEnabled: true,
  reservationEnabled: true,
  supportEnabled: true,
  fleetEnabled: true,
  aiInsightsEnabled: true,
  simEnabled: true,
  paymentTerminalsEnabled: true,
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
      visibleNavEntries(['users:write', 'logs:read'], ALL_ON, true, entries).map((e) => e.to),
    ).toEqual(['/a', '/b', '/c']);
    expect(
      visibleNavEntries(['users:read'], { ...ALL_ON, fleetEnabled: false }, true, entries).map(
        (e) => e.to,
      ),
    ).toEqual(['/a']);
    expect(visibleNavEntries([], ALL_ON, true, entries)).toEqual([]);
  });

  it('hides company-wide entries from a site-restricted user', () => {
    const entries: NavEntry[] = [
      {
        to: '/logs',
        labelKey: 'nav.logs',
        icon: Bell,
        order: 1,
        requiredPermission: 'logs:read',
        requiresAllSiteAccess: true,
      },
      {
        to: '/audit',
        labelKey: 'nav.audit',
        icon: Bell,
        order: 2,
        requiredPermission: 'audit:read',
      },
    ];
    const perms = ['logs:read', 'audit:read'];
    expect(visibleNavEntries(perms, ALL_ON, true, entries).map((e) => e.to)).toEqual([
      '/logs',
      '/audit',
    ]);
    expect(visibleNavEntries(perms, ALL_ON, false, entries).map((e) => e.to)).toEqual(['/audit']);
  });

  it('marks the logs entry as company-wide', () => {
    expect(NAV_ENTRIES.find((e) => e.to === '/logs')?.requiresAllSiteAccess).toBe(true);
  });
});

describe('AI Insights entry', () => {
  it('shows only while AI Insights are on, and no AI Inbox entry remains', () => {
    const on = visibleNavEntries(['aiInsights:read'], ALL_ON, true).map((e) => e.to);
    expect(on).toContain('/ai/insights');
    expect(NAV_ENTRIES.map((e) => e.to)).not.toContain('/ai/inbox');
    const off = visibleNavEntries(
      ['aiInsights:read'],
      { ...ALL_ON, aiInsightsEnabled: false },
      true,
    );
    expect(off.map((e) => e.to)).not.toContain('/ai/insights');
  });
});

describe('SIMs entry', () => {
  it('sits after Stations, needs sims:read and shows only while the SIM features are on', () => {
    const order = NAV_ENTRIES.map((e) => e.to);
    expect(order.indexOf('/sims')).toBe(order.indexOf('/stations') + 1);
    expect(visibleNavEntries(['sims:read'], ALL_ON, true).map((e) => e.to)).toContain('/sims');
    expect(visibleNavEntries(['stations:read'], ALL_ON, true).map((e) => e.to)).not.toContain(
      '/sims',
    );
    const off = visibleNavEntries(['sims:read'], { ...ALL_ON, simEnabled: false }, true);
    expect(off.map((e) => e.to)).not.toContain('/sims');
  });
});

describe('Payment Terminals entry', () => {
  it('is hidden from the menu while the feature is under development', () => {
    expect(PAYMENT_TERMINALS_NAV_ENABLED).toBe(false);
    const on = visibleNavEntries(['paymentTerminals:read'], ALL_ON, true).map((e) => e.to);
    expect(on).not.toContain('/payment-terminals');
  });

  it('sits after Pricing, needs paymentTerminals:read and shows only while the feature applies', () => {
    const order = NAV_ENTRIES.map((e) => e.to);
    expect(order.indexOf('/payment-terminals')).toBe(order.indexOf('/pricing') + 1);
    const entry = NAV_ENTRIES.find((e) => e.to === '/payment-terminals');
    expect(entry?.requiredPermission).toBe('paymentTerminals:read');
    expect(paymentTerminalsNavVisible(ALL_ON, true)).toBe(true);
    expect(paymentTerminalsNavVisible({ ...ALL_ON, paymentTerminalsEnabled: false }, true)).toBe(
      false,
    );
    expect(paymentTerminalsNavVisible(ALL_ON, false)).toBe(false);
  });
});
