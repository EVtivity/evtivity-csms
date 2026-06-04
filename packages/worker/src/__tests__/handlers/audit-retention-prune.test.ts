// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { Logger } from 'pino';

const { mockPruneOldRows } = vi.hoisted(() => ({
  mockPruneOldRows: vi.fn(),
}));

// A fixed AUDIT_TABLES shape so the expected table-name list is deterministic.
const AUDIT_TABLES = {
  site: {},
  station: {},
  driver: {},
};

let settingValue: unknown;

function makeSettingsChain(): Record<string, unknown> {
  const chain: Record<string, unknown> = {};
  for (const m of ['select', 'from', 'where']) chain[m] = vi.fn(() => chain);
  chain['limit'] = vi.fn(() =>
    Promise.resolve(settingValue === undefined ? [] : [{ value: settingValue }]),
  );
  return chain;
}

vi.mock('@evtivity/database', () => ({
  db: {
    select: vi.fn(() => makeSettingsChain()),
  },
  settings: { key: 'settings.key', value: 'settings.value' },
  AUDIT_TABLES,
}));

vi.mock('drizzle-orm', () => ({
  eq: vi.fn(),
}));

vi.mock('../../lib/prune-old-rows.js', () => ({
  pruneOldRows: mockPruneOldRows,
}));

function makeLog(): Logger {
  return { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } as unknown as Logger;
}

const EXPECTED_TABLES = [
  'site_audit_log',
  'station_audit_log',
  'driver_audit_log',
  'authorize_attempts',
];

beforeEach(() => {
  settingValue = undefined;
  mockPruneOldRows.mockReset();
  mockPruneOldRows.mockResolvedValue(0);
});

describe('auditRetentionPruneHandler', () => {
  it('uses the default retention (1095 days) when the setting row is missing', async () => {
    settingValue = undefined; // no row
    const { auditRetentionPruneHandler } = await import('../../handlers/audit-retention-prune.js');
    const log = makeLog();
    await auditRetentionPruneHandler(log);

    expect(mockPruneOldRows).toHaveBeenCalledTimes(EXPECTED_TABLES.length);
    for (const call of mockPruneOldRows.mock.calls) {
      expect(call[0]).toMatchObject({ retentionDays: 1095, cutoffColumn: 'created_at' });
    }
  });

  it('uses the operator-configured numeric retention value', async () => {
    settingValue = 30;
    const { auditRetentionPruneHandler } = await import('../../handlers/audit-retention-prune.js');
    await auditRetentionPruneHandler(makeLog());

    expect(
      mockPruneOldRows.mock.calls.every(
        (c) => (c[0] as { retentionDays: number }).retentionDays === 30,
      ),
    ).toBe(true);
  });

  it('falls back to default when the setting value is a non-number (string)', async () => {
    settingValue = '45';
    const { auditRetentionPruneHandler } = await import('../../handlers/audit-retention-prune.js');
    await auditRetentionPruneHandler(makeLog());

    expect((mockPruneOldRows.mock.calls[0]![0] as { retentionDays: number }).retentionDays).toBe(
      1095,
    );
  });

  it('prunes every per-entity audit_log table plus authorize_attempts', async () => {
    settingValue = 90;
    const { auditRetentionPruneHandler } = await import('../../handlers/audit-retention-prune.js');
    await auditRetentionPruneHandler(makeLog());

    const targeted = mockPruneOldRows.mock.calls.map((c) => (c[0] as { table: string }).table);
    expect(targeted).toEqual(EXPECTED_TABLES);
  });

  it('skips pruning entirely when retention is zero (disabled)', async () => {
    settingValue = 0;
    const { auditRetentionPruneHandler } = await import('../../handlers/audit-retention-prune.js');
    const log = makeLog();
    await auditRetentionPruneHandler(log);

    expect(mockPruneOldRows).not.toHaveBeenCalled();
    expect(log.info).toHaveBeenCalledWith(
      { retentionDays: 0 },
      'audit-retention-prune: retention disabled, skipping',
    );
  });

  it('skips pruning when retention is negative', async () => {
    settingValue = -1;
    const { auditRetentionPruneHandler } = await import('../../handlers/audit-retention-prune.js');
    await auditRetentionPruneHandler(makeLog());
    expect(mockPruneOldRows).not.toHaveBeenCalled();
  });

  it('logs per-table totals only for tables that deleted rows, plus a final summary', async () => {
    settingValue = 90;
    // site: 5 deleted, station: 0, driver: 12, authorize_attempts: 0
    mockPruneOldRows
      .mockResolvedValueOnce(5)
      .mockResolvedValueOnce(0)
      .mockResolvedValueOnce(12)
      .mockResolvedValueOnce(0);

    const { auditRetentionPruneHandler } = await import('../../handlers/audit-retention-prune.js');
    const log = makeLog();
    await auditRetentionPruneHandler(log);

    expect(log.info).toHaveBeenCalledWith(
      { tableName: 'site_audit_log', deleted: 5 },
      'audit-retention-prune: pruned audit rows',
    );
    expect(log.info).toHaveBeenCalledWith(
      { tableName: 'driver_audit_log', deleted: 12 },
      'audit-retention-prune: pruned audit rows',
    );
    // No per-table log for the zero-deletion tables.
    expect(log.info).not.toHaveBeenCalledWith(
      { tableName: 'station_audit_log', deleted: 0 },
      'audit-retention-prune: pruned audit rows',
    );
    // Final summary sums all deletions.
    expect(log.info).toHaveBeenCalledWith(
      { retentionDays: 90, totalDeleted: 17 },
      'audit-retention-prune complete',
    );
  });
});
