// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { Logger } from 'pino';
import * as logRetentionPruneModule from '../../handlers/log-retention-prune.js';

const { mockPruneOldRows } = vi.hoisted(() => ({
  mockPruneOldRows: vi.fn(),
}));

// `db.select(...).from(...).where(...)` resolves to whatever settingRows is set to.
let settingRows: { key: string; value: unknown }[] = [];

function makeSelectChain(): Record<string, unknown> {
  const chain: Record<string, unknown> = {};
  chain['select'] = vi.fn(() => chain);
  chain['from'] = vi.fn(() => chain);
  chain['where'] = vi.fn(() => Promise.resolve(settingRows));
  return chain;
}

vi.mock('@evtivity/database', () => ({
  db: {
    select: vi.fn(() => makeSelectChain()),
  },
  settings: { key: 'settings.key', value: 'settings.value' },
}));

vi.mock('drizzle-orm', () => ({
  inArray: vi.fn(),
  // The handler builds its login row filter at import: keep the SQL text.
  sql: (strings: TemplateStringsArray) => ({ sqlText: strings.join('?') }),
}));

vi.mock('../../lib/prune-old-rows.js', () => ({
  pruneOldRows: mockPruneOldRows,
}));

function makeLog(): Logger {
  return { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } as unknown as Logger;
}

// The handler's LOG_TABLES, in order, with their default day values + cutoff columns.
const TABLE_DEFAULTS = [
  {
    table: 'access_logs',
    settingKey: 'logs.access.retentionDays',
    defaultDays: 30,
    cutoffColumn: 'created_at',
  },
  {
    table: 'ocpp_message_logs',
    settingKey: 'logs.ocppMessage.retentionDays',
    defaultDays: 30,
    cutoffColumn: 'created_at',
  },
  {
    table: 'connection_logs',
    settingKey: 'logs.connection.retentionDays',
    defaultDays: 90,
    cutoffColumn: 'created_at',
  },
  {
    table: 'notifications',
    settingKey: 'logs.notifications.retentionDays',
    defaultDays: 90,
    cutoffColumn: 'created_at',
  },
  {
    table: 'security_events',
    settingKey: 'logs.securityEvents.retentionDays',
    defaultDays: 365,
    cutoffColumn: 'timestamp',
  },
  {
    table: 'port_status_log',
    settingKey: 'logs.portStatus.retentionDays',
    defaultDays: 30,
    cutoffColumn: 'timestamp',
  },
  {
    table: 'worker_job_logs',
    settingKey: 'logs.workerJob.retentionDays',
    defaultDays: 30,
    cutoffColumn: 'completed_at',
  },
  {
    table: 'domain_events',
    settingKey: 'logs.domainEvents.retentionDays',
    defaultDays: 30,
    cutoffColumn: 'occurred_at',
  },
  {
    table: 'meter_values',
    settingKey: 'logs.meterValues.retentionDays',
    defaultDays: 90,
    cutoffColumn: 'timestamp',
  },
  {
    table: 'load_allocation_log',
    settingKey: 'logs.loadAllocation.retentionDays',
    defaultDays: 90,
    cutoffColumn: 'created_at',
  },
  {
    table: 'user_audit_log',
    settingKey: 'logs.loginAudit.retentionDays',
    defaultDays: 90,
    cutoffColumn: 'created_at',
  },
  {
    table: 'driver_audit_log',
    settingKey: 'logs.loginAudit.retentionDays',
    defaultDays: 90,
    cutoffColumn: 'created_at',
  },
  {
    table: 'sim_sessions',
    settingKey: 'sim.sessions.retentionDays',
    defaultDays: 90,
    cutoffColumn: 'started_at',
  },
  {
    table: 'sim_alerts',
    settingKey: 'sim.sessions.retentionDays',
    defaultDays: 90,
    cutoffColumn: 'received_at',
  },
  {
    table: 'sim_fetch_coverage',
    settingKey: 'sim.sessions.retentionDays',
    defaultDays: 90,
    cutoffColumn: 'covered_to',
  },
];

beforeEach(() => {
  settingRows = [];
  mockPruneOldRows.mockReset();
  mockPruneOldRows.mockResolvedValue(0);
});

describe('logRetentionPruneHandler', () => {
  it('applies each table default retention and cutoff column when no settings exist', async () => {
    settingRows = [];
    const { logRetentionPruneHandler } = logRetentionPruneModule;
    await logRetentionPruneHandler(makeLog());

    expect(mockPruneOldRows).toHaveBeenCalledTimes(TABLE_DEFAULTS.length);
    mockPruneOldRows.mock.calls.forEach((call, i) => {
      expect(call[0]).toMatchObject({
        table: TABLE_DEFAULTS[i]!.table,
        cutoffColumn: TABLE_DEFAULTS[i]!.cutoffColumn,
        retentionDays: TABLE_DEFAULTS[i]!.defaultDays,
      });
    });
  });

  it('prunes the SIM sessions, alerts and fetched ranges with the SIM retention', async () => {
    settingRows = [{ key: 'sim.sessions.retentionDays', value: 30 }];
    const { logRetentionPruneHandler } = logRetentionPruneModule;
    await logRetentionPruneHandler(makeLog());
    const simCalls = mockPruneOldRows.mock.calls
      .map((c) => c[0] as { table: string; retentionDays: number; cutoffColumn: string })
      .filter((c) => c.table.startsWith('sim_'));
    expect(simCalls).toEqual([
      expect.objectContaining({
        table: 'sim_sessions',
        retentionDays: 30,
        cutoffColumn: 'started_at',
      }),
      expect.objectContaining({
        table: 'sim_alerts',
        retentionDays: 30,
        cutoffColumn: 'received_at',
      }),
      expect.objectContaining({
        table: 'sim_fetch_coverage',
        retentionDays: 30,
        cutoffColumn: 'covered_to',
      }),
    ]);
  });

  it('targets every log table in declaration order', async () => {
    const { logRetentionPruneHandler } = logRetentionPruneModule;
    await logRetentionPruneHandler(makeLog());
    const targeted = mockPruneOldRows.mock.calls.map((c) => (c[0] as { table: string }).table);
    expect(targeted).toEqual(TABLE_DEFAULTS.map((t) => t.table));
  });

  it('prunes only the login rows of the user and driver audit logs', async () => {
    settingRows = [{ key: 'logs.loginAudit.retentionDays', value: 14 }];
    const { logRetentionPruneHandler } = logRetentionPruneModule;
    await logRetentionPruneHandler(makeLog());
    const loginCalls = mockPruneOldRows.mock.calls
      .map((c) => c[0] as { table: string; retentionDays: number; filter?: { sqlText: string } })
      .filter((c) => c.table === 'user_audit_log' || c.table === 'driver_audit_log');
    expect(loginCalls.map((c) => c.table)).toEqual(['user_audit_log', 'driver_audit_log']);
    for (const call of loginCalls) {
      expect(call.retentionDays).toBe(14);
      expect(call.filter?.sqlText).toBe("action::text IN ('login_succeeded', 'login_failed')");
    }
    // No other table gets a filter.
    const filtered = mockPruneOldRows.mock.calls.filter(
      (c) => (c[0] as { filter?: unknown }).filter != null,
    );
    expect(filtered).toHaveLength(2);
  });

  it('keeps login rows forever when the login retention is 0', async () => {
    settingRows = [{ key: 'logs.loginAudit.retentionDays', value: 0 }];
    const { logRetentionPruneHandler } = logRetentionPruneModule;
    await logRetentionPruneHandler(makeLog());
    const targeted = mockPruneOldRows.mock.calls.map((c) => (c[0] as { table: string }).table);
    expect(targeted).not.toContain('user_audit_log');
    expect(targeted).not.toContain('driver_audit_log');
    expect(targeted).toHaveLength(TABLE_DEFAULTS.length - 2);
  });

  it('uses the operator-configured numeric override over the default', async () => {
    settingRows = [
      { key: 'logs.access.retentionDays', value: 7 },
      { key: 'logs.securityEvents.retentionDays', value: 730 },
    ];
    const { logRetentionPruneHandler } = logRetentionPruneModule;
    await logRetentionPruneHandler(makeLog());

    const accessCall = mockPruneOldRows.mock.calls.find(
      (c) => (c[0] as { table: string }).table === 'access_logs',
    );
    const secCall = mockPruneOldRows.mock.calls.find(
      (c) => (c[0] as { table: string }).table === 'security_events',
    );
    expect((accessCall![0] as { retentionDays: number }).retentionDays).toBe(7);
    expect((secCall![0] as { retentionDays: number }).retentionDays).toBe(730);
  });

  it('falls back to the default when a setting value is a non-number (string)', async () => {
    settingRows = [{ key: 'logs.access.retentionDays', value: '15' }];
    const { logRetentionPruneHandler } = logRetentionPruneModule;
    await logRetentionPruneHandler(makeLog());

    const accessCall = mockPruneOldRows.mock.calls.find(
      (c) => (c[0] as { table: string }).table === 'access_logs',
    );
    expect((accessCall![0] as { retentionDays: number }).retentionDays).toBe(30);
  });

  it('skips a single table whose retention is zero while still pruning the rest', async () => {
    settingRows = [{ key: 'logs.notifications.retentionDays', value: 0 }];
    const { logRetentionPruneHandler } = logRetentionPruneModule;
    const log = makeLog();
    await logRetentionPruneHandler(log);

    const targeted = mockPruneOldRows.mock.calls.map((c) => (c[0] as { table: string }).table);
    expect(targeted).not.toContain('notifications');
    expect(targeted).toHaveLength(TABLE_DEFAULTS.length - 1);
    expect(log.info).toHaveBeenCalledWith(
      { table: 'notifications', days: 0 },
      'log-retention-prune: disabled, skipping',
    );
  });

  it('skips a table whose retention is negative', async () => {
    settingRows = [{ key: 'logs.portStatus.retentionDays', value: -10 }];
    const { logRetentionPruneHandler } = logRetentionPruneModule;
    await logRetentionPruneHandler(makeLog());
    const targeted = mockPruneOldRows.mock.calls.map((c) => (c[0] as { table: string }).table);
    expect(targeted).not.toContain('port_status_log');
  });

  it('logs per-table deletions only for tables that deleted rows and a grand total', async () => {
    // access:100, ocpp:0, connection:0, notifications:50, security:0, port:0, worker:0
    mockPruneOldRows
      .mockResolvedValueOnce(100)
      .mockResolvedValueOnce(0)
      .mockResolvedValueOnce(0)
      .mockResolvedValueOnce(50)
      .mockResolvedValueOnce(0)
      .mockResolvedValueOnce(0)
      .mockResolvedValueOnce(0);

    const { logRetentionPruneHandler } = logRetentionPruneModule;
    const log = makeLog();
    await logRetentionPruneHandler(log);

    expect(log.info).toHaveBeenCalledWith(
      { table: 'access_logs', days: 30, deleted: 100 },
      'log-retention-prune: pruned rows',
    );
    expect(log.info).toHaveBeenCalledWith(
      { table: 'notifications', days: 90, deleted: 50 },
      'log-retention-prune: pruned rows',
    );
    expect(log.info).not.toHaveBeenCalledWith(
      expect.objectContaining({ table: 'ocpp_message_logs' }),
      'log-retention-prune: pruned rows',
    );
    expect(log.info).toHaveBeenCalledWith({ totalDeleted: 150 }, 'log-retention-prune complete');
  });
});
