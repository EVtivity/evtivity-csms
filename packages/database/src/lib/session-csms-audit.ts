// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { sessionAuditLog } from '../schema/audit.js';
import { db as defaultDb } from '../config.js';
import { writeAudit } from './audit.js';

type AuditDb = Pick<typeof defaultDb, 'insert'>;

/**
 * A session the CSMS ended on its own, not the driver or the station:
 * `faulted` when it faulted (or failed) the session row, `stopped_by_csms`
 * when it only sent RequestStopTransaction (the station's Ended then closes
 * the session). A path that faults and also sends the stop writes one
 * `faulted` row and says so in `notes`.
 */
export interface CsmsSessionAuditArgs {
  sessionId: string;
  action: 'faulted' | 'stopped_by_csms';
  /** `ocpp` inside an OCPP message projection, `system` for a sweep or a worker job. */
  actor: 'system' | 'ocpp';
  /** The stop reason (OCPP) or the job name (system). */
  actorLabel: string;
  before?: Record<string, unknown> | null;
  after: Record<string, unknown>;
  notes?: string | null;
}

/** Writes the session audit row of a CSMS-forced fault or stop. Fail-open (writeAudit). */
export async function writeCsmsSessionAudit(
  args: CsmsSessionAuditArgs,
  db: AuditDb = defaultDb,
  logger?: { warn: (obj: unknown, msg?: string) => void },
): Promise<void> {
  await writeAudit(
    { table: sessionAuditLog, idColumn: 'session_id' },
    {
      entityId: args.sessionId,
      entityIdSnapshot: args.sessionId,
      action: args.action,
      actor: args.actor,
      actorLabel: args.actorLabel.slice(0, 100),
      before: args.before ?? null,
      after: args.after,
      notes: args.notes ?? null,
    },
    db,
    logger,
  );
}
