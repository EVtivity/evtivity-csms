// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { describe, expect, it, vi } from 'vitest';
import { sql } from 'drizzle-orm';
import { PgDialect } from 'drizzle-orm/pg-core';

const { simSettings } = vi.hoisted(() => ({ simSettings: { on: true } }));

vi.mock('@evtivity/database', async () => ({
  ...(await import('@evtivity/database/src/schema/sim.js')),
}));
vi.mock('../lib/sim.js', () => ({
  readSimSettings: async () => simSettings,
  isSimFeatureOn: (s: { on: boolean }) => s.on,
}));

import {
  fetchedInSiteWindowsSql,
  inSimSiteWindowsSql,
  requireSimFeature,
  simFeatureOnRequest,
  simVisibleSql,
  simVisibleWhere,
} from '../lib/sim-site-scope.js';

const dialect = new PgDialect();

describe('SIM site scope SQL', () => {
  it('is false for a user without sites', () => {
    expect(dialect.sqlToQuery(simVisibleWhere([])).sql).toBe('false');
    expect(dialect.sqlToQuery(fetchedInSiteWindowsSql(sql`now()`, [])).sql).toBe('false');
    expect(dialect.sqlToQuery(inSimSiteWindowsSql(sql`x`, sql`now()`, [])).sql).toBe('false');
  });

  it('checks an open confirmed attachment at one of the sites', () => {
    const q = dialect.sqlToQuery(simVisibleWhere(['sit_a', 'sit_b']));
    expect(q.sql).toContain('vis_a.detached_at IS NULL');
    expect(q.sql).toContain('vis_a.confirmed_at IS NOT NULL');
    expect(q.sql).toContain('"sims"."id"');
    expect(q.params).toEqual(['sit_a', 'sit_b']);
    expect(dialect.sqlToQuery(simVisibleSql(sql`a.sim_id`, ['sit_a'])).sql).toContain(
      'vis_a.sim_id = a.sim_id',
    );
  });

  it('checks the fetch time against the confirmed attachment periods', () => {
    const q = dialect.sqlToQuery(fetchedInSiteWindowsSql(sql`s.status_fetched_at`, ['sit_a']));
    expect(q.sql).toContain('s.status_fetched_at IS NOT NULL');
    expect(q.sql).toContain('win_a.attached_at <= s.status_fetched_at');
    expect(q.params).toEqual(['sit_a']);
  });
});

describe('requireSimFeature', () => {
  function reply() {
    const r = { status: vi.fn(), send: vi.fn() };
    r.status.mockReturnValue(r);
    r.send.mockResolvedValue(r);
    return r;
  }

  it('passes while a SIM feature is on', async () => {
    simSettings.on = true;
    const r = reply();
    expect(await requireSimFeature(r as never)).toBe(true);
    expect(await simFeatureOnRequest({} as never, r as never)).toBeUndefined();
    expect(r.status).not.toHaveBeenCalled();
  });

  it('answers 400 SIM_FEATURE_DISABLED while both are off', async () => {
    simSettings.on = false;
    const r = reply();
    expect(await requireSimFeature(r as never)).toBe(false);
    expect(r.status).toHaveBeenCalledWith(400);
    expect(r.send).toHaveBeenCalledWith(expect.objectContaining({ code: 'SIM_FEATURE_DISABLED' }));
    expect(await simFeatureOnRequest({} as never, r as never)).toBe(r);
  });
});
