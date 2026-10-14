// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { db, writeAudit, stationAuditLog, type AuditActor } from '@evtivity/database';

export interface StationCommandAuditArgs {
  /** Internal station id (`charging_stations.id`). */
  stationId: string;
  actor: {
    actor: AuditActor;
    actorUserId?: string | null;
    actorDriverId?: string | null;
    actorApiKeyId?: string | null;
    actorLabel?: string | null;
  };
  /** The OCPP action sent (RequestStartTransaction, RequestStopTransaction). */
  command: string;
  sessionId: string | null;
  evseId?: number;
  /** The station's answer (`Accepted`, `Rejected`) or `error` when none came. */
  outcome: string;
}

/**
 * The outcome of a command answered through `sendOcppCommandAndWait`: the
 * station's status, or `error` when it did not answer.
 */
export function commandOutcome(result: {
  error?: string | null;
  response?: Record<string, unknown> | null;
}): string {
  if (result.error != null) return 'error';
  const status = result.response?.['status'];
  return typeof status === 'string' ? status : 'Unknown';
}

/**
 * Records a session start or stop a driver or guest sent to a station as
 * `station.command_dispatched`, like the operator command audit. Holds the
 * command, the session and the outcome, never the idToken. Fail-open.
 */
export async function recordStationCommandAudit(
  args: StationCommandAuditArgs,
  log?: { warn: (obj: unknown, msg?: string) => void },
): Promise<void> {
  await writeAudit(
    { table: stationAuditLog, idColumn: 'station_id' },
    {
      entityId: args.stationId,
      entityIdSnapshot: args.stationId,
      action: 'command_dispatched',
      ...args.actor,
      notes: `${args.command} (${args.outcome})`,
      after: {
        action: args.command,
        sessionId: args.sessionId,
        ...(args.evseId != null ? { evseId: args.evseId } : {}),
        outcome: args.outcome,
      },
    },
    db,
    log,
  );
}
