// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import type postgres from 'postgres';
import type { Logger } from '@evtivity/lib';

/** Writes a connection_logs row. Best effort: a failure is logged, never thrown. */
export async function logConnectionEvent(
  sql: postgres.Sql,
  stationDbId: string,
  event: string,
  remoteAddress: string | null,
  metadata: Record<string, unknown>,
  logger: Logger,
): Promise<void> {
  try {
    await sql`
      INSERT INTO connection_logs (station_id, event, remote_address, metadata)
      VALUES (${stationDbId}, ${event}, ${remoteAddress}, ${sql.json(metadata as Parameters<postgres.Sql['json']>[0])})
    `;
  } catch (err) {
    // Best-effort logging; do not fail the auth flow, but surface the failure
    // so operators notice when forensic logs go missing.
    logger.warn({ err, stationDbId, event }, 'Failed to write connection_logs row');
  }
}
