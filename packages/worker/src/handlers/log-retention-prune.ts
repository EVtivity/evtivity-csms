// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { db, settings } from '@evtivity/database';
import { inArray } from 'drizzle-orm';
import type { Logger } from '@evtivity/lib';
import { pruneOldRows } from '../lib/prune-old-rows.js';

// Daily cron: deletes observability log rows older than each table's
// configured retention. Distinct from `audit-retention-prune` so the
// per-entity audit log (compliance-relevant, default 1095 days) stays
// independent from high-volume operational logs that need much shorter
// retention to keep disk and query performance under control.
//
// Each setting key is read fresh on every run; operator changes take effect
// on the next firing. A setting value of 0 (or any non-positive number)
// disables pruning for that specific table.

interface LogTable {
  // Postgres table name
  table: string;
  // Setting key in the `settings` table (jsonb integer days)
  settingKey: string;
  // Fallback when the row is missing/invalid
  defaultDays: number;
  // Timestamp column to compare against the cutoff. Most log tables use
  // `created_at`; worker_job_logs uses `completed_at` so in-flight jobs
  // are never deleted.
  cutoffColumn: string;
}

const LOG_TABLES: readonly LogTable[] = [
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
    // `timestamp` is indexed and is the OCPP event time (set on insert, never
    // updated). Prune by it instead of `created_at` to use the existing
    // `idx_security_events_timestamp` btree.
    cutoffColumn: 'timestamp',
  },
  {
    table: 'port_status_log',
    settingKey: 'logs.portStatus.retentionDays',
    defaultDays: 30,
    // Same as security_events: `timestamp` is indexed and immutable.
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
    // `occurred_at` is indexed (idx_domain_events_occurred_at) and immutable.
    cutoffColumn: 'occurred_at',
  },
  {
    table: 'meter_values',
    settingKey: 'logs.meterValues.retentionDays',
    defaultDays: 90,
    // `timestamp` is indexed (idx_meter_values_timestamp) and is the meter
    // reading time, set on insert. Sessions read only recent rows; energy
    // totals live on charging_sessions, so old samples are safe to drop.
    cutoffColumn: 'timestamp',
  },
];

export async function logRetentionPruneHandler(log: Logger): Promise<void> {
  // Load all settings in one round trip rather than N queries.
  const rows = await db
    .select({ key: settings.key, value: settings.value })
    .from(settings)
    .where(
      inArray(
        settings.key,
        LOG_TABLES.map((t) => t.settingKey),
      ),
    );
  const settingMap = new Map(rows.map((r) => [r.key, r.value]));

  let grandTotal = 0;
  for (const t of LOG_TABLES) {
    const raw = settingMap.get(t.settingKey);
    const days = typeof raw === 'number' ? raw : t.defaultDays;
    if (!Number.isFinite(days) || days <= 0) {
      log.info({ table: t.table, days }, 'log-retention-prune: disabled, skipping');
      continue;
    }

    const tableDeleted = await pruneOldRows({
      table: t.table,
      cutoffColumn: t.cutoffColumn,
      retentionDays: days,
      log,
    });
    grandTotal += tableDeleted;
    if (tableDeleted > 0) {
      log.info({ table: t.table, days, deleted: tableDeleted }, 'log-retention-prune: pruned rows');
    }
  }

  log.info({ totalDeleted: grandTotal }, 'log-retention-prune complete');
}
