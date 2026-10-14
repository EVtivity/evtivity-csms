// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import type postgres from 'postgres';
import { publishOcppCommand } from '@evtivity/lib';
import type { Logger, PubSubClient } from '@evtivity/lib';

export interface OfflineQueueDrainResult {
  /** Older queued screen messages and cost updates expired as superseded. */
  superseded: number;
  /** Commands published to the station. */
  sent: number;
}

/**
 * Sends a station the commands queued while it was offline, oldest first.
 *
 * Each command is claimed before it is published: one guarded UPDATE moves
 * the pending rows to `sent` and returns them (`FOR UPDATE SKIP LOCKED`), so
 * two drains at once (a reconnect on another OCPP process, a repeated Ready)
 * split the rows and never publish a command twice, and a crash after the
 * claim cannot publish it again on the next reconnect (at most once: a station
 * command such as a reset or a remote start must not run twice). A claimed
 * command whose publish fails goes back to `pending` for the next drain,
 * unless it expired meanwhile, when it is left to the expiry cleanup.
 */
export async function drainOfflineCommandQueue(
  sql: postgres.Sql,
  pubsub: PubSubClient,
  stationOcppId: string,
  logger: Logger,
): Promise<OfflineQueueDrainResult> {
  // Only the newest queued screen message per display message id and cost
  // update per transaction still matters; older ones would show stale content.
  const superseded = await sql`
    WITH keyed AS (
      SELECT id, action, created_at,
        CASE action
          WHEN 'SetDisplayMessage' THEN payload -> 'message' ->> 'id'
          WHEN 'ClearDisplayMessage' THEN payload ->> 'id'
          WHEN 'CostUpdated' THEN payload ->> 'transactionId'
        END AS target
      FROM offline_command_queue
      WHERE station_id = ${stationOcppId} AND status = 'pending'
        AND action IN ('SetDisplayMessage', 'ClearDisplayMessage', 'CostUpdated')
    ),
    ranked AS (
      SELECT id, row_number() OVER (
        PARTITION BY action, target ORDER BY created_at DESC, id DESC
      ) AS rn
      FROM keyed
      WHERE target IS NOT NULL
    )
    UPDATE offline_command_queue q
    SET status = 'expired', failed_reason = 'Superseded by a newer queued command'
    FROM ranked
    WHERE q.id = ranked.id AND ranked.rn > 1 AND q.status = 'pending'
  `;

  const claimed = await sql`
    WITH due AS (
      SELECT id FROM offline_command_queue
      WHERE station_id = ${stationOcppId} AND status = 'pending' AND expires_at > now()
      ORDER BY created_at ASC, id ASC
      FOR UPDATE SKIP LOCKED
    )
    UPDATE offline_command_queue q
    SET status = 'sent', sent_at = now()
    FROM due
    WHERE q.id = due.id AND q.status = 'pending'
    RETURNING q.id, q.command_id, q.action, q.payload, q.version, q.created_at
  `;
  const commands = [...claimed].sort((a, b) => {
    const at = new Date(a.created_at as string).getTime();
    const bt = new Date(b.created_at as string).getTime();
    return at !== bt ? at - bt : (a.id as number) - (b.id as number);
  });

  let sent = 0;
  for (const cmd of commands) {
    try {
      await publishOcppCommand(pubsub, {
        commandId: cmd.command_id as string,
        stationId: stationOcppId,
        action: cmd.action as string,
        payload: cmd.payload as Record<string, unknown>,
        version: cmd.version as string | null,
      });
      sent++;
    } catch (publishErr) {
      logger.warn(
        { err: publishErr, stationOcppId, commandId: cmd.command_id },
        'Offline queue drain: publish failed for command; back to pending for the next drain',
      );
      try {
        await sql`
          UPDATE offline_command_queue
          SET status = 'pending', sent_at = NULL
          WHERE id = ${cmd.id as number} AND status = 'sent' AND expires_at > now()
        `;
      } catch (revertErr) {
        // fail-open: the row stays sent and the command is lost, which the
        // queued command log shows; the station keeps working.
        logger.warn(
          { err: revertErr, stationOcppId, commandId: cmd.command_id },
          'Offline queue drain: could not return an unpublished command to pending',
        );
      }
    }
  }
  return { superseded: superseded.count, sent };
}
