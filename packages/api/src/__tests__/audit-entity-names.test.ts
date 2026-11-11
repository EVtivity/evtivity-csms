// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { beforeEach, describe, expect, it, vi } from 'vitest';

const { execute } = vi.hoisted(() => ({ execute: vi.fn() }));
vi.mock('@evtivity/database', () => ({ db: { execute } }));
vi.mock('../lib/sim-site-scope.js', async () => {
  const { sql } = await import('drizzle-orm');
  return { simVisibleSql: () => sql`sim_visible_condition` };
});
vi.mock('../lib/support-case-scope.js', async () => {
  const { sql } = await import('drizzle-orm');
  return { supportCaseSiteCondition: () => sql`support_case_site_condition` };
});

import { PgDialect } from 'drizzle-orm/pg-core';
import type { SQL } from 'drizzle-orm';

import { resolveAuditEntityNames } from '../lib/audit-entity-names.js';

function row(
  entityType: string,
  entityId: string | null,
  extra: Partial<{ before: unknown; after: unknown; entityIdSnapshot: string }> = {},
) {
  return {
    entityType,
    entityId,
    entityIdSnapshot: extra.entityIdSnapshot ?? entityId ?? '',
    before: extra.before ?? null,
    after: extra.after ?? null,
    entityName: null as string | null,
  };
}

beforeEach(() => {
  execute.mockReset();
});

describe('resolveAuditEntityNames', () => {
  it('runs one query per entity type and sets the readable names', async () => {
    execute
      .mockResolvedValueOnce([{ id: 'sit_1', name: 'Downtown Garage' }])
      .mockResolvedValueOnce([{ id: 'sta_1', name: 'CS-001' }]);
    const rows = [row('site', 'sit_1'), row('site', 'sit_1'), row('station', 'sta_1')];
    await resolveAuditEntityNames(rows, null);
    expect(execute).toHaveBeenCalledTimes(2);
    expect(rows.map((r) => r.entityName)).toEqual(['Downtown Garage', 'Downtown Garage', 'CS-001']);
  });

  it('names a deleted entity from its snapshot and a setting by its key', async () => {
    execute.mockResolvedValueOnce([]);
    const rows = [
      row('fleet', null, { entityIdSnapshot: 'flt_1', before: { name: 'Night Buses' } }),
      row('setting', 'smtp.host'),
      row('certificate', '7'),
    ];
    await resolveAuditEntityNames(rows, null);
    expect(rows.map((r) => r.entityName)).toEqual(['Night Buses', 'smtp.host', null]);
  });

  it('leaves the name null when a lookup fails', async () => {
    execute.mockRejectedValueOnce(new Error('db down'));
    const warn = vi.fn();
    const rows = [row('driver', 'drv_1')];
    await resolveAuditEntityNames(rows, null, { warn });
    expect(rows[0]?.entityName).toBeNull();
    expect(warn).toHaveBeenCalledTimes(1);
  });

  // Security case 390: a site-restricted viewer never gets the current name of
  // an entity that now belongs to another site.
  describe('site-restricted viewer', () => {
    const dialect = new PgDialect();
    const queryOf = (call: number) => dialect.sqlToQuery(execute.mock.calls[call]?.[0] as SQL);

    it('filters each name query by the entity current site', async () => {
      execute.mockResolvedValueOnce([]).mockResolvedValueOnce([]);
      const rows = [
        row('payment_terminal', 'ptm_1', { after: { label: 'Old Reader' } }),
        row('station', 'sta_1'),
      ];
      await resolveAuditEntityNames(rows, ['sit_a']);
      expect(execute).toHaveBeenCalledTimes(2);
      const queries = [queryOf(0), queryOf(1)];
      const terminal = queries.find((q) => q.sql.includes('payment_terminals'));
      const station = queries.find((q) => q.sql.includes('charging_stations'));
      expect(terminal?.sql).toContain('payment_terminals.site_id IN');
      expect(terminal?.params).toContain('sit_a');
      expect(station?.sql).toContain('charging_stations.site_id IN');
      // Out of scope now: the snapshot name, else none.
      expect(rows.map((r) => r.entityName)).toEqual(['Old Reader', null]);
    });

    it('checks a session by its own and its station site, and a SIM by its visibility', async () => {
      execute.mockResolvedValue([]);
      await resolveAuditEntityNames([row('session', 'ses_1'), row('sim', 'sim_1')], ['sit_a']);
      const texts = [queryOf(0).sql, queryOf(1).sql];
      expect(texts.find((t) => t.includes('charging_sessions'))).toMatch(
        /s\.site_id IN [\s\S]* AND cs\.site_id IN/,
      );
      expect(texts.find((t) => t.includes('FROM sims'))).toContain('sim_visible_condition');
    });

    it('reads no current name of a type without a site check, only the snapshot', async () => {
      const rows = [
        row('driver', 'drv_1', { before: { name: 'Snapshot Driver' } }),
        row('fleet', 'flt_1'),
      ];
      await resolveAuditEntityNames(rows, ['sit_a']);
      expect(execute).not.toHaveBeenCalled();
      expect(rows.map((r) => r.entityName)).toEqual(['Snapshot Driver', null]);
    });

    it('reads nothing for a viewer without sites', async () => {
      const rows = [row('station', 'sta_1')];
      await resolveAuditEntityNames(rows, []);
      expect(execute).not.toHaveBeenCalled();
      expect(rows[0]?.entityName).toBeNull();
    });

    it('keeps the current name for an all-site viewer, with no site filter', async () => {
      execute.mockResolvedValueOnce([{ id: 'ptm_1', name: 'Site B Reader' }]);
      const rows = [row('payment_terminal', 'ptm_1', { after: { label: 'Old Reader' } })];
      await resolveAuditEntityNames(rows, null);
      expect(queryOf(0).sql).not.toContain('site_id IN');
      expect(rows[0]?.entityName).toBe('Site B Reader');
    });
  });
});
