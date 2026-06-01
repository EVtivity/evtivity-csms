// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { and, eq, lte, sql } from 'drizzle-orm';
import { db, maintenanceEvents } from '@evtivity/database';
import type { Logger } from 'pino';
import {
  enterMaintenance,
  exitMaintenance,
} from '@evtivity/api/src/services/maintenance.service.js';

const SYSTEM_ACTOR = { type: 'system' as const, label: 'maintenance-scheduler' };

export async function maintenanceSchedulerHandler(log: Logger): Promise<void> {
  // SELECT-only here. enterMaintenance performs the atomic status+started_at
  // transition inside its own CASE-guarded UPDATE so its single-mutation
  // contract (and its `started_at IS NULL` re-entry guard) stays intact. A
  // pre-UPDATE in the worker would set started_at = now() and cause every
  // side effect to be skipped on the next call.
  const dueScheduled = await db
    .select({ id: maintenanceEvents.id })
    .from(maintenanceEvents)
    .where(
      and(
        eq(maintenanceEvents.status, 'scheduled'),
        lte(maintenanceEvents.plannedStartAt, sql`now()`),
      ),
    );

  for (const row of dueScheduled) {
    try {
      await enterMaintenance(row.id, SYSTEM_ACTOR, log);
    } catch (err) {
      log.warn({ err, eventId: row.id }, 'maintenance-scheduler: enterMaintenance failed');
    }
  }

  const dueEnd = await db
    .select({ id: maintenanceEvents.id })
    .from(maintenanceEvents)
    .where(
      and(eq(maintenanceEvents.status, 'active'), lte(maintenanceEvents.plannedEndAt, sql`now()`)),
    );

  for (const row of dueEnd) {
    try {
      await exitMaintenance(row.id, SYSTEM_ACTOR, log);
    } catch (err) {
      log.warn({ err, eventId: row.id }, 'maintenance-scheduler: exitMaintenance failed');
    }
  }

  log.info({ activated: dueScheduled.length, ended: dueEnd.length }, 'maintenance-scheduler tick');
}
