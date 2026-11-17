// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { describe, expect, it } from 'vitest';
import {
  DASHBOARD_LAYOUT_MAX_ITEMS,
  DASHBOARD_SITE_ID_MAX_LENGTH,
  DASHBOARD_WIDGETS,
  dashboardLayoutProblem,
  defaultDashboardLayout,
  isDefaultDashboardLayout,
  resolveDashboardLayout,
} from '../dashboard-layout.js';

describe('dashboard layout', () => {
  it('has unique ids and hides only the four new charts and the security events card by default', () => {
    const ids = DASHBOARD_WIDGETS.map((w) => w.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(
      DASHBOARD_WIDGETS.filter((w) => w.defaultHidden && w.fleet !== true)
        .map((w) => w.id)
        .sort(),
    ).toEqual([
      'chart.evsesByConnectorType',
      'chart.freeVend',
      'chart.locationsByCity',
      'chart.plugAndCharge',
      'chart.securityEvents',
    ]);
    for (const w of DASHBOARD_WIDGETS) {
      expect(w.id.startsWith('chart.')).toBe(true);
    }
  });

  it('accepts the default layout and a partial one, ignoring the stat cards of an earlier client', () => {
    expect(dashboardLayoutProblem(defaultDashboardLayout())).toBeNull();
    expect(
      dashboardLayoutProblem({ version: 1, charts: [{ id: 'chart.energy', hidden: true }] }),
    ).toBeNull();
    expect(
      dashboardLayoutProblem({
        version: 1,
        cards: [{ id: 'card.uptime', hidden: true }],
        charts: [],
      }),
    ).toBeNull();
  });

  it('refuses unknown ids, stat card ids, duplicates and oversized input', () => {
    expect(dashboardLayoutProblem({ version: 1, charts: [{ id: 'nope', hidden: false }] })).toMatch(
      /unknown/,
    );
    expect(
      dashboardLayoutProblem({ version: 1, charts: [{ id: 'card.totalStations', hidden: false }] }),
    ).toMatch(/unknown/);
    expect(
      dashboardLayoutProblem({
        version: 1,
        charts: [
          { id: 'chart.energy', hidden: false },
          { id: 'chart.energy', hidden: true },
        ],
      }),
    ).toMatch(/duplicate/);
    expect(
      dashboardLayoutProblem({
        version: 1,
        charts: Array.from({ length: DASHBOARD_LAYOUT_MAX_ITEMS + 1 }, () => ({
          id: 'chart.energy',
          hidden: false,
        })),
      }),
    ).toMatch(/more than/);
    expect(dashboardLayoutProblem({ version: 2, charts: [] })).toMatch(/version/);
    expect(dashboardLayoutProblem({ version: 1, charts: [{ id: 'chart.energy' }] })).toMatch(
      /id, hidden/,
    );
    expect(dashboardLayoutProblem(null)).toMatch(/object/);
    expect(dashboardLayoutProblem({ version: 1, charts: {} })).toMatch(/array/);
    expect(dashboardLayoutProblem({ version: 1 })).toMatch(/array/);
  });

  it('drops removed and stat card ids and appends missing charts at their default visibility', () => {
    const resolved = resolveDashboardLayout({
      version: 1,
      cards: [{ id: 'card.uptime', hidden: true }],
      charts: [
        { id: 'chart.freeVend', hidden: false },
        { id: 'chart.gone', hidden: false },
        { id: 'card.totalStations', hidden: true },
        { id: 'chart.freeVend', hidden: true },
        { id: 'chart.energy', hidden: true },
      ],
    });
    expect(Object.keys(resolved)).toEqual(['version', 'charts']);
    expect(resolved.charts[0]).toEqual({ id: 'chart.freeVend', hidden: false });
    expect(resolved.charts[1]).toEqual({ id: 'chart.energy', hidden: true });
    expect(resolved.charts.some((c) => !c.id.startsWith('chart.'))).toBe(false);
    expect(resolved.charts.some((c) => c.id === 'chart.gone')).toBe(false);
    expect(resolved.charts.filter((c) => c.id === 'chart.freeVend')).toHaveLength(1);
    expect(resolved.charts.find((c) => c.id === 'chart.plugAndCharge')?.hidden).toBe(true);
    expect(resolved.charts).toHaveLength(DASHBOARD_WIDGETS.length);
    expect(resolveDashboardLayout(null)).toEqual(defaultDashboardLayout());
    expect(resolveDashboardLayout({ version: 7 })).toEqual(defaultDashboardLayout());
  });

  it('places the security events card hidden, full width, right after the station status chart', () => {
    const ids = defaultDashboardLayout().charts.map((c) => c.id);
    expect(ids.indexOf('chart.securityEvents')).toBe(ids.indexOf('chart.stationStatus') + 1);
    expect(DASHBOARD_WIDGETS.find((w) => w.id === 'chart.securityEvents')).toMatchObject({
      defaultHidden: true,
      span: 'full',
    });
    expect(defaultDashboardLayout().charts.find((c) => c.id === 'chart.securityEvents')).toEqual({
      id: 'chart.securityEvents',
      hidden: true,
    });
    // A layout saved before the card existed gets it, hidden, before the utilization chart.
    const saved = defaultDashboardLayout()
      .charts.filter((c) => c.id !== 'chart.securityEvents')
      .reverse();
    const resolved = resolveDashboardLayout({ version: 1, charts: saved }).charts;
    const at = resolved.findIndex((c) => c.id === 'chart.securityEvents');
    expect(resolved[at + 1]?.id).toBe('chart.utilization');
    expect(resolved[at]?.hidden).toBe(true);
    // A layout that saved the card shown keeps it shown.
    const shown = defaultDashboardLayout().charts.map((c) =>
      c.id === 'chart.securityEvents' ? { ...c, hidden: false } : c,
    );
    const kept = resolveDashboardLayout({ version: 1, charts: shown }).charts;
    expect(kept.find((c) => c.id === 'chart.securityEvents')?.hidden).toBe(false);
  });

  it('puts the 3D site layout above the map in the default layout and in a layout saved before it', () => {
    const ids = defaultDashboardLayout().charts.map((c) => c.id);
    expect(ids.indexOf('chart.siteLayout3d')).toBe(ids.indexOf('chart.stationMap') - 1);
    expect(defaultDashboardLayout().charts.find((c) => c.id === 'chart.siteLayout3d')).toEqual({
      id: 'chart.siteLayout3d',
      hidden: false,
    });

    // A layout saved before the widget existed, with the map moved to the top.
    const saved = defaultDashboardLayout()
      .charts.filter((c) => c.id !== 'chart.siteLayout3d')
      .reverse();
    const resolved = resolveDashboardLayout({ version: 1, charts: saved }).charts.map((c) => c.id);
    expect(resolved.indexOf('chart.siteLayout3d')).toBe(resolved.indexOf('chart.stationMap') - 1);
    expect(resolved).toHaveLength(DASHBOARD_WIDGETS.length);

    // Every other missing chart is appended; the widget goes above the map.
    const partial = resolveDashboardLayout({
      version: 1,
      charts: [
        { id: 'chart.stationMap', hidden: false },
        { id: 'chart.energy', hidden: false },
      ],
    }).charts.map((c) => c.id);
    expect(partial.slice(0, 3)).toEqual(['chart.siteLayout3d', 'chart.stationMap', 'chart.energy']);
    expect(partial[3]).toBe('chart.aiInsights');
  });

  it('keeps the site of the 3D site layout and refuses a site on any other chart', () => {
    const withSite = {
      version: 1,
      charts: [
        { id: 'chart.siteLayout3d', hidden: false, siteId: 'sit_1' },
        { id: 'chart.energy', hidden: false, siteId: null },
      ],
    };
    expect(dashboardLayoutProblem(withSite)).toBeNull();
    const resolved = resolveDashboardLayout(withSite).charts;
    expect(resolved[0]).toEqual({ id: 'chart.siteLayout3d', hidden: false, siteId: 'sit_1' });
    expect(resolved[1]).toEqual({ id: 'chart.energy', hidden: false });

    expect(
      dashboardLayoutProblem({
        version: 1,
        charts: [{ id: 'chart.energy', hidden: false, siteId: 'sit_1' }],
      }),
    ).toMatch(/takes no siteId/);
    for (const siteId of ['', 5, 'x'.repeat(DASHBOARD_SITE_ID_MAX_LENGTH + 1)]) {
      expect(
        dashboardLayoutProblem({
          version: 1,
          charts: [{ id: 'chart.siteLayout3d', hidden: false, siteId }],
        }),
      ).toMatch(/siteId/);
    }
    // A stored site that is not a valid id is dropped on read.
    expect(
      resolveDashboardLayout({
        version: 1,
        charts: [{ id: 'chart.siteLayout3d', hidden: true, siteId: 42 }],
      }).charts[0],
    ).toEqual({ id: 'chart.siteLayout3d', hidden: true });
  });

  it('tells the default layout from a customized one', () => {
    expect(isDefaultDashboardLayout(defaultDashboardLayout())).toBe(true);
    const moved = defaultDashboardLayout();
    moved.charts.reverse();
    expect(isDefaultDashboardLayout(moved)).toBe(false);
  });
});

describe('dashboard fleet items', () => {
  const FLEET_IDS = [
    'chart.fleetEnergy',
    'chart.fleetSessions',
    'chart.fleetCost',
    'chart.fleetInvoices',
  ];
  const shown = (layout: ReturnType<typeof defaultDashboardLayout>): string[] =>
    layout.charts.filter((c) => !c.hidden).map((c) => c.id);

  it('hides the fleet charts by default for operators and shows them to fleet users', () => {
    expect(DASHBOARD_WIDGETS.filter((w) => w.fleet === true).map((w) => w.id)).toEqual(FLEET_IDS);
    const operator = defaultDashboardLayout();
    for (const id of FLEET_IDS) {
      expect(operator.charts.find((c) => c.id === id)?.hidden, id).toBe(true);
    }
    const fleetUser = defaultDashboardLayout({ fleetUser: true });
    expect(shown(fleetUser)).toEqual(expect.arrayContaining(FLEET_IDS));
    expect(isDefaultDashboardLayout(fleetUser, { fleetUser: true })).toBe(true);
    expect(isDefaultDashboardLayout(fleetUser)).toBe(false);
  });

  it('adds the fleet charts to a layout saved before them with the audience default', () => {
    const saved = { version: 1, charts: [{ id: 'chart.energy', hidden: false }] };
    const forFleetUser = resolveDashboardLayout(saved, { fleetUser: true });
    expect(shown(forFleetUser)).toEqual(expect.arrayContaining(FLEET_IDS));
    const forOperator = resolveDashboardLayout(saved);
    expect(shown(forOperator).some((id) => FLEET_IDS.includes(id))).toBe(false);
  });

  it('skips the fleet items of a saved layout while Fleets is off, and keeps the rest', () => {
    const saved = {
      version: 1,
      charts: [
        { id: 'chart.fleetEnergy', hidden: false },
        { id: 'chart.energy', hidden: false },
      ],
    };
    expect(dashboardLayoutProblem(saved)).toBeNull();
    const off = resolveDashboardLayout(saved, { fleetsEnabled: false });
    expect(off.charts.some((c) => FLEET_IDS.includes(c.id))).toBe(false);
    expect(off.charts[0]).toEqual({ id: 'chart.energy', hidden: false });
    expect(
      defaultDashboardLayout({ fleetUser: true, fleetsEnabled: false }).charts.map((c) => c.id),
    ).not.toContain('chart.fleetEnergy');
    // On again: the saved place and visibility come back.
    expect(resolveDashboardLayout(saved).charts[0]).toEqual({
      id: 'chart.fleetEnergy',
      hidden: false,
    });
  });
});
