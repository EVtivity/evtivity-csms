// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { PgDialect } from 'drizzle-orm/pg-core';

const { results, selects } = vi.hoisted(() => ({
  results: { queue: [] as unknown[][] },
  selects: { count: 0 },
}));

vi.mock('@evtivity/database', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@evtivity/database')>();
  const chain = {
    from: () => chain,
    where: () => Promise.resolve(results.queue.shift() ?? []),
  };
  return {
    ...actual,
    db: {
      select: () => {
        selects.count += 1;
        return chain;
      },
    },
  };
});

vi.mock('@evtivity/lib/pubsub-instance', () => ({
  getPubSub: () => ({ publish: vi.fn(() => Promise.resolve()) }),
}));

import {
  clearFleetScopeCacheLocal,
  fleetInScope,
  fleetPaidSessionCondition,
  getUserAccessScope,
  isFleetUser,
  requireFleetAccess,
  userAccessFields,
} from '../lib/fleet-scope.js';
import { clearSiteAccessCacheLocal, getUserSiteIds } from '../lib/site-access.js';

const USER = 'usr_fleetscope01';

function reply(): { statusCode: number | null; body: unknown } & FastifyReply {
  const r = {
    statusCode: null as number | null,
    body: undefined as unknown,
    status(code: number) {
      r.statusCode = code;
      return r;
    },
    send(body: unknown) {
      r.body = body;
      return Promise.resolve(r);
    },
  };
  return r as unknown as { statusCode: number | null; body: unknown } & FastifyReply;
}

describe('fleet scope', () => {
  beforeEach(() => {
    results.queue = [];
    selects.count = 0;
    clearFleetScopeCacheLocal(USER);
    clearSiteAccessCacheLocal(USER);
  });

  it('reads a fleet user with its fleets, sorted, and caches it', async () => {
    results.queue = [[{ accessScope: 'fleets' }], [{ fleetId: 'flt_b' }, { fleetId: 'flt_a' }]];
    expect(await getUserAccessScope(USER)).toEqual({
      kind: 'fleets',
      fleetIds: ['flt_a', 'flt_b'],
    });
    expect(await isFleetUser(USER)).toBe(true);
    expect(selects.count).toBe(2);
    expect(await userAccessFields(USER)).toEqual({
      accessScope: 'fleets',
      fleetIds: ['flt_a', 'flt_b'],
    });
    expect(selects.count).toBe(2);
  });

  it('reads a site user without a fleet lookup, and a missing user as sites', async () => {
    results.queue = [[{ accessScope: 'sites' }]];
    expect(await getUserAccessScope(USER)).toEqual({ kind: 'sites' });
    expect(selects.count).toBe(1);
    expect(await userAccessFields(USER)).toEqual({ accessScope: 'sites', fleetIds: [] });

    clearFleetScopeCacheLocal(USER);
    results.queue = [[]];
    expect(await getUserAccessScope(USER)).toEqual({ kind: 'sites' });
  });

  it('drops the cached scope with the site access cache', async () => {
    results.queue = [[{ accessScope: 'sites' }], [{ accessScope: 'fleets' }], []];
    expect(await isFleetUser(USER)).toBe(false);
    clearSiteAccessCacheLocal(USER);
    expect(await isFleetUser(USER)).toBe(true);
  });

  it('gives a fleet user no sites, even with stale site rows', async () => {
    results.queue = [[{ hasAllSiteAccess: false, accessScope: 'fleets' }]];
    expect(await getUserSiteIds(USER)).toEqual([]);
    // No assignment read: the scope alone decides.
    expect(selects.count).toBe(1);
  });

  it('fleetInScope: every fleet for sites, only assigned fleets for a fleet user', () => {
    expect(fleetInScope({ kind: 'sites' }, 'flt_x')).toBe(true);
    expect(fleetInScope({ kind: 'fleets', fleetIds: ['flt_a'] }, 'flt_a')).toBe(true);
    expect(fleetInScope({ kind: 'fleets', fleetIds: ['flt_a'] }, 'flt_x')).toBe(false);
  });

  it('requireFleetAccess answers 404 FLEET_NOT_FOUND for a fleet not assigned', async () => {
    results.queue = [[{ accessScope: 'fleets' }], [{ fleetId: 'flt_a' }]];
    const request = { user: { userId: USER } } as unknown as FastifyRequest;
    const own = reply();
    expect(await requireFleetAccess(request, own, 'flt_a')).toBe(true);
    expect(own.statusCode).toBeNull();

    const other = reply();
    expect(await requireFleetAccess(request, other, 'flt_x')).toBe(false);
    expect(other.statusCode).toBe(404);
    expect(other.body).toEqual({ error: 'Fleet not found', code: 'FLEET_NOT_FOUND' });
  });

  it('fleetPaidSessionCondition selects account sessions of the fleets not billed to a member', () => {
    const dialect = new PgDialect();
    const query = dialect.sqlToQuery(fleetPaidSessionCondition(['flt_a', 'flt_b']));
    expect(query.sql).toContain('"billing_mode" = $1');
    expect(query.sql).toContain('"billing_fleet_id" in ($2, $3)');
    expect(query.sql).toContain('"member_billed" = $4');
    expect(query.params).toEqual(['account', 'flt_a', 'flt_b', false]);
  });

  it('fleetPaidSessionCondition matches nothing without a fleet', () => {
    const dialect = new PgDialect();
    expect(dialect.sqlToQuery(fleetPaidSessionCondition([])).sql).toBe('false');
  });
});
