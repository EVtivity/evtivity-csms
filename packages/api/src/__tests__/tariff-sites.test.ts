// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

// Site availability of tariffs (D-B): the reader view and the assignment
// guard. The real-database cases are in 09-pricing.integration.test.ts.

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { FastifyRequest } from 'fastify';

const h = vi.hoisted(() => ({
  results: [] as unknown[][],
  userSites: null as string[] | null,
  executed: 0,
}));

function chain(): Record<string, unknown> {
  const c: Record<string, unknown> = {};
  for (const m of ['select', 'from', 'where', 'limit', 'insert', 'values', 'delete']) {
    c[m] = vi.fn(() => c);
  }
  c['onConflictDoNothing'] = vi.fn(() => Promise.resolve([]));
  c['then'] = (resolve: (v: unknown) => unknown) =>
    Promise.resolve(h.results.shift() ?? []).then(resolve);
  return c;
}

vi.mock('@evtivity/database', () => {
  const db = {
    select: vi.fn(() => chain()),
    insert: vi.fn(() => chain()),
    delete: vi.fn(() => chain()),
    execute: vi.fn(() => {
      h.executed += 1;
      return Promise.resolve([]);
    }),
    transaction: vi.fn((fn: (tx: unknown) => unknown) => fn(db)),
  };
  const col = (name: string) => ({ name });
  return {
    db,
    pricingGroups: { id: col('id'), isDefault: col('is_default') },
    pricingGroupSites: { id: col('id'), pricingGroupId: col('pricing_group_id') },
    pricingGroupStations: { id: col('id'), pricingGroupId: col('pricing_group_id') },
    sites: { id: col('id') },
    tariffSites: { tariffId: col('tariff_id'), siteId: col('site_id') },
    tariffs: {
      id: col('id'),
      pricingGroupId: col('pricing_group_id'),
      siteScope: col('site_scope'),
    },
  };
});
vi.mock('drizzle-orm', () => ({
  and: vi.fn(),
  eq: vi.fn(),
  inArray: vi.fn(),
  sql: vi.fn(),
}));
vi.mock('../lib/site-access.js', () => ({
  getUserSiteIds: vi.fn(() => Promise.resolve(h.userSites)),
}));

const { assignToStationOrSite, SiteLimitedGroupError, tariffViews } =
  await import('../lib/tariff-sites.js');

const request = { user: { userId: 'usr_1' } } as unknown as FastifyRequest;
const rows = [
  { id: 'trf_all', siteScope: 'all' },
  { id: 'trf_sel', siteScope: 'selected' },
];

beforeEach(() => {
  h.results = [];
  h.userSites = null;
  h.executed = 0;
});

describe('tariffViews', () => {
  it('lists every selected site for an all-site reader', async () => {
    h.results = [
      [
        { tariffId: 'trf_sel', siteId: 'sit_b' },
        { tariffId: 'trf_sel', siteId: 'sit_a' },
      ],
    ];
    const views = await tariffViews(request, rows);
    expect(views[0]).toMatchObject({ siteIds: null, otherSiteCount: 0 });
    expect(views[1]).toMatchObject({ siteIds: ['sit_a', 'sit_b'], otherSiteCount: 0 });
  });

  it('shows a site-restricted reader only its own sites and counts the rest', async () => {
    h.userSites = ['sit_a'];
    h.results = [
      [
        { tariffId: 'trf_sel', siteId: 'sit_a' },
        { tariffId: 'trf_sel', siteId: 'sit_b' },
        { tariffId: 'trf_sel', siteId: 'sit_c' },
      ],
    ];
    const views = await tariffViews(request, rows);
    expect(views[1]).toMatchObject({ siteIds: ['sit_a'], otherSiteCount: 2 });
  });
});

describe('assignToStationOrSite', () => {
  it('refuses a group with a Selected Sites tariff under the scope lock', async () => {
    h.results = [[{ id: 'trf_sel' }]];
    const run = vi.fn();
    await expect(assignToStationOrSite('pgr_1', run)).rejects.toBeInstanceOf(SiteLimitedGroupError);
    expect(run).not.toHaveBeenCalled();
    expect(h.executed).toBe(1);
  });

  it('runs the assignment for a group without one', async () => {
    h.results = [[]];
    const run = vi.fn(() => Promise.resolve('done'));
    await expect(assignToStationOrSite('pgr_1', run)).resolves.toBe('done');
  });
});
