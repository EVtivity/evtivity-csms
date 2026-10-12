// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

// Every /ai/insights/:id route hides the same insights: one visibility gate
// (lib/ai-insight-scope.ts) for the detail, write, action and neighbors
// routes, with the permission of the detail route for reads.

import { readFileSync } from 'node:fs';
import { describe, it, expect, vi, beforeEach } from 'vitest';

const state = vi.hoisted(() => ({ reservationEnabled: true }));

vi.mock('@evtivity/database', () => ({
  aiInsights: { kind: { name: 'kind' } },
  isReservationEnabled: vi.fn(() => Promise.resolve(state.reservationEnabled)),
}));
vi.mock('drizzle-orm', () => ({
  notInArray: vi.fn((col: unknown, values: unknown) => ({ notInArray: [col, values] })),
}));

import { aiInsights } from '@evtivity/database';
import { insightFeatureGateSql, insightRowVisible } from '../lib/ai-insight-scope.js';

describe('insight visibility gate', () => {
  beforeEach(() => {
    state.reservationEnabled = true;
  });

  it('shows an insight in the caller sites; unsited ones for all-site users only', async () => {
    const row = { siteId: 'sit_a', kind: 'station_offline' };
    expect(await insightRowVisible(row, null)).toBe(true);
    expect(await insightRowVisible(row, ['sit_a'])).toBe(true);
    expect(await insightRowVisible(row, ['sit_b'])).toBe(false);
    expect(await insightRowVisible(row, [])).toBe(false);
    expect(await insightRowVisible({ siteId: null, kind: 'station_offline' }, null)).toBe(true);
    expect(await insightRowVisible({ siteId: null, kind: 'station_offline' }, ['sit_a'])).toBe(
      false,
    );
  });

  it('hides reservation insights while reservations are off, in row and SQL form', async () => {
    const row = { siteId: 'sit_a', kind: 'reservation_no_show' };
    expect(await insightRowVisible(row, null)).toBe(true);
    expect(await insightFeatureGateSql()).toBeUndefined();

    state.reservationEnabled = false;
    expect(await insightRowVisible(row, null)).toBe(false);
    expect(await insightRowVisible({ siteId: 'sit_a', kind: 'station_offline' }, null)).toBe(true);
    const gate = (await insightFeatureGateSql()) as unknown as { notInArray: [unknown, string[]] };
    expect(gate.notInArray[0]).toBe(aiInsights.kind);
    expect(gate.notInArray[1]).toContain('reservation_no_show');
    expect(gate.notInArray[1]).not.toContain('station_offline');
  });
});

describe('insight route parity guard', () => {
  const read = (path: string): string => readFileSync(new URL(path, import.meta.url), 'utf8');
  const insightsSource = read('../routes/ai-insights.ts');
  const neighborsSource = read('../routes/entity-neighbors.ts');

  /** Each `app.<method>('/ai/insights/:id...'` registration with its handler source. */
  function idRoutes(): Array<{ method: string; path: string; body: string }> {
    const re = /app\.(get|post|put|patch|delete)\(\s*'([^']+)'/g;
    const matches = [...insightsSource.matchAll(re)];
    return matches
      .map((m, i) => ({
        method: m[1] ?? '',
        path: m[2] ?? '',
        body: insightsSource.slice(m.index, matches[i + 1]?.index ?? insightsSource.length),
      }))
      .filter((r) => r.path.startsWith('/ai/insights/:id'));
  }

  it('finds the insight routes it guards', () => {
    const paths = idRoutes().map((r) => `${r.method} ${r.path}`);
    expect(paths).toEqual(
      expect.arrayContaining([
        'get /ai/insights/:id',
        'post /ai/insights/:id/regenerate',
        'post /ai/insights/:id/dismiss',
        'post /ai/insights/:id/feedback',
        'delete /ai/insights/:id/feedback',
        'post /ai/insights/:id/action/confirm',
        'post /ai/insights/:id/action/reject',
      ]),
    );
  });

  it('every /ai/insights/:id route resolves its insight through insightInScope', () => {
    // decidableAction (action confirm and reject) resolves through insightInScope.
    expect(insightsSource).toMatch(
      /async function decidableAction[\s\S]*?await insightInScope\(id, await getUserSiteIds\(userId\)\)/,
    );
    expect(insightsSource).toMatch(
      /async function insightInScope[\s\S]*?await insightRowVisible\(row, siteIds\)/,
    );
    for (const route of idRoutes()) {
      expect(
        /insightInScope\(id, siteIds\)|decidableAction\(request, reply\)/.test(route.body),
        `${route.method.toUpperCase()} ${route.path} must resolve the insight through insightInScope`,
      ).toBe(true);
      expect(
        route.body,
        `${route.method.toUpperCase()} ${route.path} uses getInsightRow`,
      ).not.toMatch(/getInsightRow\(id\)/);
      const permission = route.method === 'get' ? 'aiInsights:read' : 'aiInsights:write';
      expect(route.body).toContain(`authorize('${permission}')`);
    }
  });

  it('the insight neighbors route applies the same gate to the current row', () => {
    const target = /\{\s*path: '\/ai\/insights\/:id\/neighbors',[\s\S]*?\n {2}\},/.exec(
      neighborsSource,
    )?.[0];
    expect(target).toBeDefined();
    expect(target).toContain("permission: 'aiInsights:read'");
    expect(target).toContain("notFoundCode: 'AI_INSIGHT_NOT_FOUND'");
    expect(target).toContain('scopeWhere: (siteIds) => inArray(aiInsights.siteId, siteIds)');
    expect(target).toContain('visibleWhereNow: insightFeatureGateSql');
    // No other neighbors route serves the insight path.
    expect(neighborsSource.match(/'\/ai\/insights\/:id\/neighbors'/g)).toHaveLength(1);
  });
});
