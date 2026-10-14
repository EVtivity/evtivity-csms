// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import type { FastifyRequest } from 'fastify';
import { db, siteAuditLog, stationAuditLog, writeAudit } from '@evtivity/database';
import { getAuditActor } from './audit-actor.js';

type Row = Record<string, unknown>;

/**
 * Site audit row for a load management change (configuration, panel, circuit,
 * unmanaged load). Fail-open: writeAudit logs and continues.
 */
export async function writeSiteLoadManagementAudit(
  request: FastifyRequest,
  siteId: string,
  change: { before: unknown; after: unknown; notes: string },
): Promise<void> {
  await writeAudit(
    { table: siteAuditLog, idColumn: 'site_id' },
    {
      entityId: siteId,
      entityIdSnapshot: siteId,
      action: 'load_management_changed',
      ...getAuditActor(request),
      before: change.before,
      after: change.after,
      notes: change.notes,
    },
    db,
    request.log,
  );
}

/** Station `updated` audit row for a load management field of the station. */
export async function writeStationLoadAudit(
  request: FastifyRequest,
  stationId: string,
  change: { before: Row; after: Row; notes: string },
): Promise<void> {
  await writeAudit(
    { table: stationAuditLog, idColumn: 'station_id' },
    {
      entityId: stationId,
      entityIdSnapshot: stationId,
      action: 'updated',
      ...getAuditActor(request),
      before: change.before,
      after: change.after,
      notes: change.notes,
    },
    db,
    request.log,
  );
}
