// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { sql, type SQL } from 'drizzle-orm';
import { PgDialect } from 'drizzle-orm/pg-core';

const results: unknown[][] = [];
function makeChain(): Record<string, unknown> {
  const chain: Record<string, unknown> = {};
  for (const m of ['select', 'from', 'where']) {
    chain[m] = vi.fn(() => chain);
  }
  chain['then'] = (resolve?: (v: unknown) => unknown, reject?: (r: unknown) => unknown) =>
    Promise.resolve(results.shift() ?? []).then(resolve, reject);
  return chain;
}

vi.mock('@evtivity/database', () => ({
  db: { select: vi.fn(() => makeChain()) },
  users: {
    id: 'users.id',
    hasAllSiteAccess: 'users.has_all_site_access',
    isActive: 'users.is_active',
  },
  userSiteAssignments: { userId: 'usa.user_id', siteId: 'usa.site_id' },
  userPermissions: { userId: 'up.user_id', permission: 'up.permission' },
}));

import {
  intersectSiteScopes,
  stationSiteInScope,
  siteScopeVisibleTo,
  userSiteScope,
  scheduleRunScope,
  scheduleSkipReason,
} from '../report-scope.js';

const dialect = new PgDialect();
function render(condition: SQL | undefined): { sql: string; params: unknown[] } | undefined {
  return condition == null ? undefined : dialect.sqlToQuery(condition);
}

beforeEach(() => {
  results.length = 0;
});

describe('intersectSiteScopes', () => {
  it('treats null as all sites', () => {
    expect(intersectSiteScopes(null, null)).toBeNull();
    expect(intersectSiteScopes(null, ['a'])).toEqual(['a']);
    expect(intersectSiteScopes(['a', 'b'], null)).toEqual(['a', 'b']);
  });

  it('keeps only the sites both scopes cover, without duplicates', () => {
    expect(intersectSiteScopes(['a', 'b', 'b', 'c'], ['b', 'c', 'd'])).toEqual(['b', 'c']);
  });

  it('returns an empty scope, never all sites, when nothing overlaps', () => {
    expect(intersectSiteScopes(['a'], ['b'])).toEqual([]);
    expect(intersectSiteScopes([], null)).toEqual([]);
  });
});

describe('stationSiteInScope', () => {
  const column = sql.raw('cs.site_id');

  it('adds no condition for an all-site scope', () => {
    expect(stationSiteInScope(column, null)).toBeUndefined();
  });

  it('matches nothing for an empty scope', () => {
    expect(render(stationSiteInScope(column, []))).toMatchObject({ sql: 'false', params: [] });
  });

  it('matches the station site against the scope (a null site never matches)', () => {
    expect(render(stationSiteInScope(column, ['a', 'b']))).toMatchObject({
      sql: 'cs.site_id = ANY(ARRAY[$1, $2]::text[])',
      params: ['a', 'b'],
    });
  });
});

describe('siteScopeVisibleTo', () => {
  const column = sql.raw('r.site_scope');

  it('shows every row to an all-site user', () => {
    expect(siteScopeVisibleTo(column, null)).toBeUndefined();
  });

  it('shows a restricted user only rows with a scope inside their sites', () => {
    expect(render(siteScopeVisibleTo(column, ['a']))).toMatchObject({
      sql: '(r.site_scope IS NOT NULL AND r.site_scope <@ ARRAY[$1]::text[])',
      params: ['a'],
    });
  });

  it('compares with an empty array for a user without sites', () => {
    expect(render(siteScopeVisibleTo(column, []))?.sql).toBe(
      '(r.site_scope IS NOT NULL AND r.site_scope <@ ARRAY[]::text[])',
    );
  });
});

describe('userSiteScope', () => {
  it('returns null for an all-site user', async () => {
    results.push([{ hasAllSiteAccess: true }]);
    expect(await userSiteScope('usr_1')).toBeNull();
  });

  it('returns the site assignments of a restricted user', async () => {
    results.push([{ hasAllSiteAccess: false }], [{ siteId: 'a' }, { siteId: 'b' }]);
    expect(await userSiteScope('usr_1')).toEqual(['a', 'b']);
  });

  it('covers nothing for an unknown user', async () => {
    results.push([]);
    expect(await userSiteScope('usr_gone')).toEqual([]);
  });
});

describe('scheduleSkipReason', () => {
  it('skips a schedule without a creator', async () => {
    expect(await scheduleSkipReason(null)).toBe('no_creator');
  });

  it('skips a schedule whose creator is missing', async () => {
    results.push([]);
    expect(await scheduleSkipReason('usr_gone')).toBe('creator_missing');
  });

  it('skips a schedule whose creator is deactivated', async () => {
    results.push([{ isActive: false }]);
    expect(await scheduleSkipReason('usr_1')).toBe('creator_inactive');
  });

  it('skips a schedule whose creator lost reports:read', async () => {
    results.push([{ isActive: true }], [{ permission: 'stations:read' }]);
    expect(await scheduleSkipReason('usr_1')).toBe('creator_lacks_reports_read');
  });

  it('runs for an active creator with reports:read or reports:write', async () => {
    results.push([{ isActive: true }], [{ permission: 'reports:read' }]);
    expect(await scheduleSkipReason('usr_1')).toBeNull();
    results.push([{ isActive: true }], [{ permission: 'reports:write' }]);
    expect(await scheduleSkipReason('usr_1')).toBeNull();
  });
});

describe('scheduleRunScope', () => {
  it('keeps the stored scope for an all-site creator', async () => {
    results.push([{ hasAllSiteAccess: true }]);
    expect(await scheduleRunScope(['a', 'b'], 'usr_1')).toEqual(['a', 'b']);
  });

  it('narrows the stored scope to the creator current sites', async () => {
    results.push([{ hasAllSiteAccess: false }], [{ siteId: 'b' }, { siteId: 'c' }]);
    expect(await scheduleRunScope(['a', 'b'], 'usr_1')).toEqual(['b']);
  });

  it('narrows an all-site schedule to a creator who lost all-site access', async () => {
    results.push([{ hasAllSiteAccess: false }], [{ siteId: 'c' }]);
    expect(await scheduleRunScope(null, 'usr_1')).toEqual(['c']);
  });
});
