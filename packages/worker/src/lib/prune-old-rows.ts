// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { sql } from 'drizzle-orm';
import { db } from '@evtivity/database';
import type { Logger } from '@evtivity/lib';

/**
 * Batched DELETE of rows older than `retentionDays` from `table`, comparing
 * `cutoffColumn` against NOW() - retentionDays. Used by both
 * `audit-retention-prune` (entity audit logs + authorize_attempts) and
 * `log-retention-prune` (operational logs) so the loop shape, lock
 * behaviour, and error semantics stay in one place.
 *
 * Returns the number of deleted rows. Errors are caught and logged at
 * `warn` so a single table's failure doesn't abort the surrounding handler
 * mid-loop; the caller is expected to continue with the next table.
 *
 * Batched via a CTE so a multi-million-row prune doesn't hold an exclusive
 * lock for the whole duration. Each batch is its own statement, allowing
 * reads and writes to interleave. The loop exits when a batch returns less
 * than `batchSize` rows (nothing left in the cutoff window).
 *
 * `retentionDays <= 0` (or non-finite) is treated as "disabled, skip" --
 * the caller-side check is redundant but kept here for safety.
 */
export async function pruneOldRows(args: {
  table: string;
  cutoffColumn: string;
  retentionDays: number;
  batchSize?: number;
  log: Logger;
}): Promise<number> {
  const { table, cutoffColumn, retentionDays, log } = args;
  const batchSize = args.batchSize ?? 1000;

  if (!Number.isFinite(retentionDays) || retentionDays <= 0) {
    return 0;
  }

  const cutoff = sql`NOW() - (${retentionDays} || ' days')::interval`;
  let total = 0;

  try {
    // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition
    while (true) {
      const res = await db.execute(
        sql`
          WITH batch AS (
            SELECT id FROM ${sql.identifier(table)}
            WHERE ${sql.identifier(cutoffColumn)} < ${cutoff}
            LIMIT ${batchSize}
          )
          DELETE FROM ${sql.identifier(table)} WHERE id IN (SELECT id FROM batch)
        `,
      );
      // db.execute returns the postgres.js result list, whose affected-row
      // count is `count` (there is no `rowCount`).
      const deleted = res.count;
      total += deleted;
      if (deleted < batchSize) break;
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    log.warn({ table, err: msg }, 'pruneOldRows: prune failed for table');
  }

  return total;
}
