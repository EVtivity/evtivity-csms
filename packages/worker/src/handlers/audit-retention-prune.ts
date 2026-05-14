// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { sql } from 'drizzle-orm';
import { db, settings, AUDIT_TABLES } from '@evtivity/database';
import { eq } from 'drizzle-orm';
import type { Logger } from '@evtivity/lib';

const DEFAULT_RETENTION_DAYS = 1095;

// Daily cron: deletes audit rows older than `audit.retentionDays` from every
// table in AUDIT_TABLES plus the OCPP authorize-attempts log (which records
// every Authorize call and shares the same retention semantics). The
// retention setting is read fresh each run so operator changes take effect
// on the next schedule.
export async function auditRetentionPruneHandler(log: Logger): Promise<void> {
  const [row] = await db
    .select({ value: settings.value })
    .from(settings)
    .where(eq(settings.key, 'audit.retentionDays'))
    .limit(1);
  const raw = row?.value;
  const retentionDays = typeof raw === 'number' ? raw : DEFAULT_RETENTION_DAYS;
  if (!Number.isFinite(retentionDays) || retentionDays <= 0) {
    log.info({ retentionDays }, 'audit-retention-prune: retention disabled, skipping');
    return;
  }

  const cutoffSql = sql`NOW() - (${retentionDays} || ' days')::interval`;

  // Every per-entity audit table is keyed by entity_type in AUDIT_TABLES.
  // We also prune authorize_attempts (anonymous OCPP authorize records;
  // not in AUDIT_TABLES because it isn't entity-scoped) on the same schedule.
  const tableNames = [
    ...Object.keys(AUDIT_TABLES).map((k) => `${k}_audit_log`),
    'authorize_attempts',
  ];

  // Delete in batches so a multi-million-row prune does not hold an
  // exclusive table lock for the entire run. Each batch is a separate
  // statement, so reads and writes can interleave between batches.
  const BATCH_SIZE = 1000;
  let totalDeleted = 0;
  for (const tableName of tableNames) {
    try {
      let tableDeleted = 0;
      // The CTE form uses a WHERE on the primary key so the LIMIT is honored
      // (Postgres does not support LIMIT directly in DELETE).
      // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition
      while (true) {
        const res = await db.execute(
          sql`
            WITH batch AS (
              SELECT id FROM ${sql.identifier(tableName)}
              WHERE created_at < ${cutoffSql}
              LIMIT ${BATCH_SIZE}
            )
            DELETE FROM ${sql.identifier(tableName)} WHERE id IN (SELECT id FROM batch)
          `,
        );
        const deleted = (res as unknown as { rowCount?: number }).rowCount ?? 0;
        tableDeleted += deleted;
        if (deleted < BATCH_SIZE) break;
      }
      totalDeleted += tableDeleted;
      if (tableDeleted > 0) {
        log.info({ tableName, deleted: tableDeleted }, 'audit-retention-prune: pruned audit rows');
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      log.warn({ tableName, err: msg }, 'audit-retention-prune: prune failed for table');
    }
  }

  log.info({ retentionDays, totalDeleted }, 'audit-retention-prune complete');
}
