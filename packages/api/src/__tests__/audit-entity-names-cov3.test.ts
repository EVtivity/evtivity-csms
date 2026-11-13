// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { SQL } from 'drizzle-orm';
import { PgDialect } from 'drizzle-orm/pg-core';

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

import { resolveAuditEntityNames } from '../lib/audit-entity-names.js';

const dialect = new PgDialect();

/** Each named type and the table its name query reads. */
const TYPES: Array<[string, string]> = [
  ['site', 'FROM sites'],
  ['station', 'FROM charging_stations'],
  ['local_auth_list', 'FROM charging_stations'],
  ['driver', 'FROM drivers'],
  ['user', 'FROM users'],
  ['fleet', 'FROM fleets'],
  ['vehicle', 'FROM vehicles'],
  ['support_case', 'FROM support_cases'],
  ['ocpi_partner', 'FROM ocpi_partners'],
  ['role', 'FROM roles'],
  ['api_key', 'FROM refresh_tokens'],
  ['config_template', 'FROM config_templates'],
  ['firmware_campaign', 'FROM firmware_campaigns'],
  ['pricing_group', 'FROM pricing_groups'],
  ['tariff', 'FROM tariffs'],
  ['holiday', 'FROM pricing_holidays'],
  ['invoice', 'FROM invoices'],
  ['ai_conversation', 'FROM ai_conversations'],
  ['report_schedule', 'FROM report_schedules'],
  ['sim', 'FROM sims'],
  ['payment_terminal', 'FROM payment_terminals'],
  ['depot_system', 'FROM depot_systems'],
  ['token', 'FROM driver_tokens'],
  ['reservation', 'FROM reservations'],
  ['session', 'FROM charging_sessions s JOIN charging_stations cs'],
  ['event_alert_rule', 'FROM event_alert_rules'],
];

function row(entityType: string, entityId: string | null, entityIdSnapshot = entityId ?? '') {
  return {
    entityType,
    entityId,
    entityIdSnapshot,
    before: null as unknown,
    after: null as unknown,
    entityName: null as string | null,
  };
}

beforeEach(() => {
  execute.mockReset();
  // Answer each query with a name built from its id parameters.
  execute.mockImplementation((statement: SQL) => {
    const q = dialect.sqlToQuery(statement);
    return Promise.resolve(
      (q.params as string[])
        .filter((p) => p.startsWith('id_'))
        .map((id) => ({ id, name: `name of ${id}` })),
    );
  });
});

describe('resolveAuditEntityNames for every named type', () => {
  it('reads each type from its own table and names its rows', async () => {
    const rows = TYPES.map(([type]) => row(type, `id_${type}`));
    await resolveAuditEntityNames(rows, null);
    expect(execute).toHaveBeenCalledTimes(TYPES.length);
    const sqls = execute.mock.calls.map((c) => dialect.sqlToQuery(c[0] as SQL).sql);
    for (const [type, table] of TYPES) {
      expect(
        sqls.some((s) => s.includes(table)),
        type,
      ).toBe(true);
    }
    expect(rows.map((r) => r.entityName)).toEqual(TYPES.map(([type]) => `name of id_${type}`));
  });

  it('adds the current site condition of each scoped type for a site-restricted viewer', async () => {
    const scoped = [
      'site',
      'station',
      'local_auth_list',
      'session',
      'reservation',
      'payment_terminal',
      'sim',
      'support_case',
      'driver',
    ];
    const rows = scoped.map((type) => row(type, `id_${type}`));
    await resolveAuditEntityNames(rows, ['sit_1']);
    // The driver has no scope condition: no current name is read for it.
    expect(execute).toHaveBeenCalledTimes(scoped.length - 1);
    const sqls = execute.mock.calls.map((c) => dialect.sqlToQuery(c[0] as SQL).sql).join('\n');
    expect(sqls).toContain('sites.id::text IN ($');
    expect(sqls).toContain('s.site_id IN ($');
    expect(sqls).toContain('FROM charging_stations rcs WHERE rcs.id = reservations.station_id');
    expect(sqls).toContain('payment_terminals.site_id IN ($');
    expect(sqls).toContain('sim_visible_condition');
    expect(sqls).toContain('support_case_site_condition');
    expect(rows.find((r) => r.entityType === 'driver')?.entityName).toBeNull();
  });

  it('reads no name for an empty id and names a setting by its snapshot key', async () => {
    const empty = row('site', null, '');
    const setting = row('setting', null, 'company.name');
    await resolveAuditEntityNames([empty, setting], null);
    expect(execute).not.toHaveBeenCalled();
    expect(empty.entityName).toBeNull();
    expect(setting.entityName).toBe('company.name');
  });

  it('falls back to the snapshot label when the current name is blank', async () => {
    execute.mockResolvedValue([{ id: 'id_payment_terminal', name: '  ' }]);
    const r = row('payment_terminal', 'id_payment_terminal');
    r.before = { label: 'Front Reader' };
    r.after = { label: '' };
    await resolveAuditEntityNames([r], null);
    expect(r.entityName).toBe('Front Reader');
  });
});
