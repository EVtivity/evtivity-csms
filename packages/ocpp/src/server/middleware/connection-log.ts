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

/** One aggregated failure row per station and reason for this long. */
export const CONNECTION_FAILURE_WINDOW_MS = 60_000;
/** Distinct remote addresses and certificate serials kept per aggregated row. */
export const CONNECTION_FAILURE_MAX_SOURCES = 20;
/** Station and reason pairs tracked per process; the oldest is flushed first. */
const CONNECTION_FAILURE_MAX_ENTRIES = 10_000;

interface FailureWindow {
  startedAt: number;
  count: number;
  /** The id of the row the first failure wrote; null while that insert runs or after it failed. */
  rowId: Promise<number | null>;
  flushedCount: number;
  // Who tried: distinct addresses and certificate serials, bounded, with the
  // number of distinct ones past the bound.
  addresses: Set<string>;
  addressesDropped: number;
  serials: Set<string>;
  serialsDropped: number;
  timer: NodeJS.Timeout;
  sql: postgres.Sql;
  logger: Logger;
}

const failureWindows = new Map<string, FailureWindow>();

function addBounded(set: Set<string>, value: string): boolean {
  if (set.has(value)) return true;
  if (set.size >= CONNECTION_FAILURE_MAX_SOURCES) return false;
  set.add(value);
  return true;
}

function noteSource(window: FailureWindow, address: string | null, serial: string | null): void {
  if (address != null && !addBounded(window.addresses, address)) window.addressesDropped++;
  if (serial != null && !addBounded(window.serials, serial)) window.serialsDropped++;
}

async function flushWindow(key: string, window: FailureWindow): Promise<void> {
  if (failureWindows.get(key) === window) failureWindows.delete(key);
  clearTimeout(window.timer);
  if (window.count === window.flushedCount) return;
  const rowId = await window.rowId;
  if (rowId == null) return;
  window.flushedCount = window.count;
  const patch: Record<string, unknown> = {
    count: window.count,
    remoteAddresses: [...window.addresses],
    remoteAddressesDropped: window.addressesDropped,
  };
  if (window.serials.size > 0 || window.serialsDropped > 0) {
    patch['certSerials'] = [...window.serials];
    patch['certSerialsDropped'] = window.serialsDropped;
  }
  try {
    await window.sql`
      UPDATE connection_logs
      SET metadata = COALESCE(metadata, '{}'::jsonb) || ${window.sql.json(patch as Parameters<postgres.Sql['json']>[0])}
      WHERE id = ${rowId}
    `;
  } catch (err) {
    window.logger.warn({ err, rowId }, 'Failed to update the connection_logs failure count');
  }
}

/**
 * Logs a failed connection: the first failure of a station and reason writes
 * a row (`metadata.count` 1), the next ones within CONNECTION_FAILURE_WINDOW_MS
 * only count in memory, and the window end updates that row's `count` once.
 * So a client that floods a station id writes about one row a minute per
 * reason, not one per attempt. Best effort, like logConnectionEvent.
 */
export async function logConnectionFailure(
  sql: postgres.Sql,
  stationDbId: string,
  event: string,
  remoteAddress: string | null,
  metadata: Record<string, unknown>,
  logger: Logger,
): Promise<void> {
  const reason = typeof metadata['reason'] === 'string' ? metadata['reason'] : '';
  const key = `${stationDbId}\u0000${event}\u0000${reason}`;
  const now = Date.now();
  const open = failureWindows.get(key);
  const serial = typeof metadata['certSerial'] === 'string' ? metadata['certSerial'] : null;
  if (open != null && now - open.startedAt < CONNECTION_FAILURE_WINDOW_MS) {
    open.count++;
    noteSource(open, remoteAddress, serial);
    return;
  }
  if (open != null) await flushWindow(key, open);
  while (failureWindows.size >= CONNECTION_FAILURE_MAX_ENTRIES) {
    const oldest = failureWindows.entries().next().value;
    if (oldest == null) break;
    await flushWindow(oldest[0], oldest[1]);
  }
  const rowId = (async (): Promise<number | null> => {
    try {
      const [row] = await sql<Array<{ id: number }>>`
        INSERT INTO connection_logs (station_id, event, remote_address, metadata)
        VALUES (${stationDbId}, ${event}, ${remoteAddress}, ${sql.json({ ...metadata, count: 1 })})
        RETURNING id
      `;
      return row?.id ?? null;
    } catch (err) {
      logger.warn({ err, stationDbId, event }, 'Failed to write connection_logs row');
      return null;
    }
  })();
  const window: FailureWindow = {
    startedAt: now,
    count: 1,
    rowId,
    flushedCount: 1,
    addresses: new Set(),
    addressesDropped: 0,
    serials: new Set(),
    serialsDropped: 0,
    sql,
    logger,
    timer: setTimeout(() => {
      void flushWindow(key, window);
    }, CONNECTION_FAILURE_WINDOW_MS),
  };
  window.timer.unref();
  noteSource(window, remoteAddress, serial);
  failureWindows.set(key, window);
  await rowId;
}

/** Writes the counts of every open failure window (shutdown, tests). */
export async function flushConnectionFailureLogs(): Promise<void> {
  await Promise.all([...failureWindows.entries()].map(([key, w]) => flushWindow(key, w)));
}
