// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import type { FastifyRequest } from 'fastify';
import { db, stationAuditLog, writeAudit } from '@evtivity/database';
import { getAuditActor } from './audit-actor.js';

/** Station audit actions written by the request-scoped helper below. */
export type StationAuditAction = (typeof stationAuditLog.action.enumValues)[number];

export interface StationAuditChange {
  before?: unknown;
  after?: unknown;
  notes?: string | null;
}

/**
 * Writes one `station_audit_log` row for an operator request, after the
 * mutation succeeded. Fail-open: writeAudit logs a failed insert at warn and
 * never throws, so the response is unaffected.
 */
export async function auditStationChange(
  request: FastifyRequest,
  stationId: string,
  action: StationAuditAction,
  change: StationAuditChange,
): Promise<void> {
  await writeAudit(
    { table: stationAuditLog, idColumn: 'station_id' },
    {
      entityId: stationId,
      entityIdSnapshot: stationId,
      action,
      ...getAuditActor(request),
      before: change.before ?? null,
      after: change.after ?? null,
      notes: change.notes ?? null,
    },
    db,
    request.log,
  );
}
