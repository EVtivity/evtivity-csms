// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { describe, it, expect, vi, beforeEach } from 'vitest';

const { state } = vi.hoisted(() => ({
  state: { results: [] as unknown[][], wheres: [] as unknown[] },
}));

function makeChain(): Record<string, unknown> {
  const chain: Record<string, unknown> = {};
  for (const m of ['select', 'from', 'innerJoin']) chain[m] = vi.fn(() => chain);
  chain['where'] = vi.fn((w: unknown) => {
    state.wheres.push(w);
    return chain;
  });
  chain['then'] = (resolve: (v: unknown) => unknown) =>
    Promise.resolve(state.results.shift() ?? []).then(resolve);
  return chain;
}

vi.mock('@evtivity/database', () => ({
  db: { select: vi.fn(() => makeChain()) },
  chargingStations: { id: 'cs.id', siteId: 'cs.siteId' },
  configTemplates: { id: 'ct.id', stationId: 'ct.stationId', targetFilter: 'ct.targetFilter' },
  firmwareCampaigns: { id: 'fc.id', targetFilter: 'fc.targetFilter', createdById: 'fc.createdBy' },
  firmwareCampaignStations: { campaignId: 'fcs.campaignId', stationId: 'fcs.stationId' },
  chargingProfileTemplates: { id: 'cpt.id', targetFilter: 'cpt.targetFilter' },
}));

vi.mock('drizzle-orm', () => ({
  eq: vi.fn((a: unknown, b: unknown) => ({ eq: [a, b] })),
  and: vi.fn((...a: unknown[]) => ({ and: a })),
  or: vi.fn((...a: unknown[]) => ({ or: a })),
  inArray: vi.fn((a: unknown, b: unknown) => ({ inArray: [a, b] })),
  notInArray: vi.fn((a: unknown, b: unknown) => ({ notInArray: [a, b] })),
  isNull: vi.fn((a: unknown) => ({ isNull: a })),
  exists: vi.fn((a: unknown) => ({ exists: a })),
  notExists: vi.fn((a: unknown) => ({ notExists: a })),
  sql: vi.fn(() => ({ sql: true })),
}));

import {
  targetFilterOutOfScope,
  targetFilterNotFound,
  isRestrictedCompanyWideWrite,
  findScopedConfigTemplate,
  findScopedFirmwareCampaign,
  findScopedChargingProfileTemplate,
} from '../lib/fleet-operation-scope.js';

beforeEach(() => {
  state.results = [];
  state.wheres = [];
});

describe('isRestrictedCompanyWideWrite', () => {
  it('never refuses an all-site user', () => {
    expect(isRestrictedCompanyWideWrite(null, null)).toBe(false);
  });

  it('refuses a restricted user a template without a site or station target', () => {
    expect(isRestrictedCompanyWideWrite(['sit_a'], null)).toBe(true);
    expect(isRestrictedCompanyWideWrite(['sit_a'], {})).toBe(true);
    expect(isRestrictedCompanyWideWrite(['sit_a'], { vendorId: 'v', model: 'M' })).toBe(true);
    expect(isRestrictedCompanyWideWrite(['sit_a'], { siteId: '', stationId: '' })).toBe(true);
  });

  it('allows a restricted user a template that names a site or station or is bound', () => {
    expect(isRestrictedCompanyWideWrite(['sit_a'], { siteId: 'sit_a' })).toBe(false);
    expect(isRestrictedCompanyWideWrite(['sit_a'], { stationId: 'sta_1' })).toBe(false);
    expect(isRestrictedCompanyWideWrite(['sit_a'], null, 'sta_1')).toBe(false);
  });
});

describe('targetFilterOutOfScope', () => {
  it('allows any filter for an all-site user without a query', async () => {
    expect(await targetFilterOutOfScope({ siteId: 'sit_b', stationId: 'sta_b' }, null)).toBeNull();
    expect(state.wheres).toHaveLength(0);
  });

  it('allows a filter without a site or station', async () => {
    expect(await targetFilterOutOfScope({ vendorId: 'v', siteId: '' }, ['sit_a'])).toBeNull();
    expect(await targetFilterOutOfScope(null, ['sit_a'])).toBeNull();
  });

  it('refuses a site outside the user sites', async () => {
    expect(await targetFilterOutOfScope({ siteId: 'sit_b' }, ['sit_a'])).toBe('site');
  });

  it('allows a station of the user sites', async () => {
    state.results = [[{ siteId: 'sit_a' }]];
    expect(await targetFilterOutOfScope({ stationId: 'sta_a' }, ['sit_a'])).toBeNull();
  });

  it('refuses a station of another site, an unsited station and a missing one', async () => {
    state.results = [[{ siteId: 'sit_b' }], [{ siteId: null }], []];
    expect(await targetFilterOutOfScope({ stationId: 'sta_b' }, ['sit_a'])).toBe('station');
    expect(await targetFilterOutOfScope({ stationId: 'sta_u' }, ['sit_a'])).toBe('station');
    expect(await targetFilterOutOfScope({ stationId: 'sta_x' }, ['sit_a'])).toBe('station');
  });

  it('maps the out-of-scope part to its 404 body', () => {
    expect(targetFilterNotFound('site')).toEqual({
      error: 'Site not found',
      code: 'SITE_NOT_FOUND',
    });
    expect(targetFilterNotFound('station').code).toBe('STATION_NOT_FOUND');
  });
});

describe('scoped loaders', () => {
  it('load by id alone for an all-site user', async () => {
    state.results = [[{ id: 'ct_1' }], [{ id: 'fc_1' }], [{ id: 'cpt_1' }]];
    expect(await findScopedConfigTemplate('ct_1', null)).toEqual({ id: 'ct_1' });
    expect(await findScopedFirmwareCampaign('fc_1', null, 'usr_1')).toEqual({ id: 'fc_1' });
    expect(await findScopedChargingProfileTemplate('cpt_1', null)).toEqual({ id: 'cpt_1' });
    expect(state.wheres).toEqual([
      { eq: ['ct.id', 'ct_1'] },
      { eq: ['fc.id', 'fc_1'] },
      { eq: ['cpt.id', 'cpt_1'] },
    ]);
  });

  it('add the site scope for a restricted user and return undefined when out of scope', async () => {
    expect(await findScopedConfigTemplate('ct_1', ['sit_a'])).toBeUndefined();
    const last = state.wheres.at(-1) as { and: unknown[] };
    expect(last.and[0]).toEqual({ eq: ['ct.id', 'ct_1'] });
    expect(last.and).toHaveLength(2);
  });

  it('scope a firmware campaign by its creator when it targets no site', async () => {
    expect(await findScopedFirmwareCampaign('fc_1', ['sit_a'], 'usr_1')).toBeUndefined();
    const last = state.wheres.at(-1) as { and: [unknown, { and: unknown[] }] };
    const scope = last.and[1].and;
    expect(scope[2]).toMatchObject({
      or: expect.arrayContaining([{ eq: ['fc.createdBy', 'usr_1'] }]),
    });
  });
});
