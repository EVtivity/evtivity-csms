// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { describe, it, expect, vi, beforeEach } from 'vitest';

let dbResults: unknown[][] = [];
let dbCallIndex = 0;

function setupDbResults(...results: unknown[][]) {
  dbResults = results;
  dbCallIndex = 0;
}

function makeChain() {
  const chain: Record<string, unknown> = {};
  const methods = [
    'select',
    'from',
    'where',
    'orderBy',
    'limit',
    'offset',
    'innerJoin',
    'leftJoin',
    'groupBy',
    'values',
    'returning',
    'set',
    'onConflictDoUpdate',
    'delete',
  ];
  for (const m of methods) {
    chain[m] = vi.fn(() => chain);
  }
  let awaited = false;
  chain['then'] = (onFulfilled?: (v: unknown) => unknown, onRejected?: (r: unknown) => unknown) => {
    if (!awaited) {
      awaited = true;
      const result = dbResults[dbCallIndex] ?? [];
      dbCallIndex++;
      return Promise.resolve(result).then(onFulfilled, onRejected);
    }
    return Promise.resolve([]).then(onFulfilled, onRejected);
  };
  chain['catch'] = (onRejected?: (r: unknown) => unknown) => Promise.resolve([]).catch(onRejected);
  return chain;
}

vi.mock('@evtivity/database', () => ({
  db: {
    select: vi.fn(() => makeChain()),
    insert: vi.fn(() => makeChain()),
    update: vi.fn(() => makeChain()),
    delete: vi.fn(() => makeChain()),
  },
  users: {
    id: 'id',
    hasAllSiteAccess: 'hasAllSiteAccess',
  },
  userSiteAssignments: {
    id: 'id',
    userId: 'userId',
    siteId: 'siteId',
  },
}));

vi.mock('drizzle-orm', () => ({
  eq: vi.fn(),
  and: vi.fn(),
  or: vi.fn(),
  ilike: vi.fn(),
  sql: vi.fn(),
  desc: vi.fn(),
}));

import { getUserSiteIds, invalidateSiteAccessCache } from '../lib/site-access.js';

beforeEach(() => {
  dbResults = [];
  dbCallIndex = 0;
  vi.clearAllMocks();
  // Clear the internal cache between tests by invalidating a known user
  // We need to reset the module cache to clear the Map
});

// Helper to reset the module-level cache by re-importing
// Since we can't easily reset the Map, we invalidate known user IDs in each test
function clearCache(userId: string) {
  invalidateSiteAccessCache(userId);
}

describe('getUserSiteIds', () => {
  it('returns null when user has hasAllSiteAccess=true', async () => {
    const userId = 'user-all-access';
    clearCache(userId);
    setupDbResults([{ hasAllSiteAccess: true }]);

    const result = await getUserSiteIds(userId);

    expect(result).toBeNull();
  });

  it('returns array of site IDs when user has specific assignments', async () => {
    const userId = 'user-with-sites';
    clearCache(userId);
    setupDbResults(
      [{ hasAllSiteAccess: false }],
      [{ siteId: 'site-1' }, { siteId: 'site-2' }, { siteId: 'site-3' }],
    );

    const result = await getUserSiteIds(userId);

    expect(result).toEqual(['site-1', 'site-2', 'site-3']);
  });

  it('returns empty array when user has no assignments', async () => {
    const userId = 'user-no-sites';
    clearCache(userId);
    setupDbResults([{ hasAllSiteAccess: false }], []);

    const result = await getUserSiteIds(userId);

    expect(result).toEqual([]);
  });

  it('returns empty array when user not found', async () => {
    const userId = 'user-not-found';
    clearCache(userId);
    setupDbResults([]);

    const result = await getUserSiteIds(userId);

    expect(result).toEqual([]);
  });

  it('caches results and does not hit DB on second call', async () => {
    const userId = 'user-cached';
    clearCache(userId);
    setupDbResults([{ hasAllSiteAccess: true }]);

    const { db } = await import('@evtivity/database');

    const first = await getUserSiteIds(userId);
    expect(first).toBeNull();

    // Reset DB mock call count
    const selectCallCount = vi.mocked(db.select).mock.calls.length;

    const second = await getUserSiteIds(userId);
    expect(second).toBeNull();

    // db.select should not have been called again
    expect(vi.mocked(db.select).mock.calls.length).toBe(selectCallCount);
  });

  it('invalidateSiteAccessCache clears the cache', async () => {
    const userId = 'user-invalidate';
    clearCache(userId);

    // First call: user has all-site access
    setupDbResults([{ hasAllSiteAccess: true }]);
    const first = await getUserSiteIds(userId);
    expect(first).toBeNull();

    // Invalidate cache
    invalidateSiteAccessCache(userId);

    // Second call: user now has specific sites
    setupDbResults([{ hasAllSiteAccess: false }], [{ siteId: 'site-a' }]);
    const second = await getUserSiteIds(userId);
    expect(second).toEqual(['site-a']);
  });
});
