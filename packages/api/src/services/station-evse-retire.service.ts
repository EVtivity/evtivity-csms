// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { and, eq, inArray, sql } from 'drizzle-orm';
import type { FastifyBaseLogger } from 'fastify';
import { AppError } from '@evtivity/lib';
import {
  db,
  client,
  chargingStations,
  chargingSessions,
  connectors,
  evses,
  reservations,
  recomputeStationAvailability,
  stationAuditLog,
  writeAudit,
} from '@evtivity/database';
import { sendAvailabilityCommand } from '@evtivity/services/availability-command';
import type { AuditActorInfo } from '../lib/audit-actor.js';
import { publishStationStatusChanged } from '../lib/station-status-events.js';

// The only writer of evses.retired_at and connectors.retired_at.
//
// Retiring takes hardware with charging history out of service instead of
// deleting it: the EVSE or connector and every session, reservation and meter
// value that refers to it stay. A retired EVSE or connector is hidden from
// drivers (portal and mobile routes), roaming partners (OCPI publishes a
// retired EVSE as REMOVED and leaves a retired connector out), new sessions
// and reservations, the derived station status and availability, and uptime.
// The station is told the EVSE or connector is Inoperative (fail-open). A
// station report for it is still stored, and it stays retired until an
// operator restores it.

const IN_USE_STATUSES = [
  'occupied',
  'charging',
  'preparing',
  'ev_connected',
  'suspended_ev',
  'suspended_evse',
  'idle',
  'discharging',
] as const;

export interface RetireContext {
  actor: AuditActorInfo;
  log: FastifyBaseLogger;
}

export interface RetireResult {
  /** When it was retired, null once restored. */
  retiredAt: Date | null;
  /** False when it already was in the requested state. */
  changed: boolean;
}

interface EvseTarget {
  stationDbId: string;
  stationOcppId: string;
  siteId: string | null;
  disabledReason: string | null;
  evseDbId: string;
  evseId: number;
  evseRetiredAt: Date | null;
}

async function loadEvse(stationDbId: string, evseId: number): Promise<EvseTarget> {
  const [row] = await db
    .select({
      stationOcppId: chargingStations.stationId,
      siteId: chargingStations.siteId,
      disabledReason: chargingStations.disabledReason,
      evseDbId: evses.id,
      evseRetiredAt: evses.retiredAt,
    })
    .from(evses)
    .innerJoin(chargingStations, eq(chargingStations.id, evses.stationId))
    .where(and(eq(evses.stationId, stationDbId), eq(evses.evseId, evseId)));
  if (row == null) throw new AppError('EVSE not found', 404, 'EVSE_NOT_FOUND');
  return { stationDbId, evseId, ...row };
}

async function loadConnector(
  target: EvseTarget,
  connectorId: number,
): Promise<{ id: string; retiredAt: Date | null }> {
  const [row] = await db
    .select({ id: connectors.id, retiredAt: connectors.retiredAt })
    .from(connectors)
    .where(and(eq(connectors.evseId, target.evseDbId), eq(connectors.connectorId, connectorId)));
  if (row == null) throw new AppError('Connector not found', 404, 'CONNECTOR_NOT_FOUND');
  return row;
}

// Hardware in use, or held for a driver, keeps running until that ends.
async function assertRetirable(evseDbId: string, connectorDbId?: string): Promise<void> {
  const [inUse] = await db
    .select({ id: connectors.id })
    .from(connectors)
    .where(
      and(
        connectorDbId != null ? eq(connectors.id, connectorDbId) : eq(connectors.evseId, evseDbId),
        inArray(connectors.status, [...IN_USE_STATUSES]),
      ),
    )
    .limit(1);
  const [active] = await db
    .select({ id: chargingSessions.id })
    .from(chargingSessions)
    .where(
      and(
        connectorDbId != null
          ? eq(chargingSessions.connectorId, connectorDbId)
          : eq(chargingSessions.evseId, evseDbId),
        eq(chargingSessions.status, 'active'),
      ),
    )
    .limit(1);
  if (inUse != null || active != null) {
    throw new AppError(
      'The EVSE or connector is in use. Stop the session before retiring it.',
      409,
      'CONNECTOR_OCCUPIED',
    );
  }
  const [held] = await db
    .select({ id: reservations.id })
    .from(reservations)
    .where(
      and(
        eq(reservations.evseId, evseDbId),
        inArray(reservations.status, ['active', 'scheduled', 'in_use']),
        sql`${reservations.expiresAt} > now()`,
      ),
    )
    .limit(1);
  if (held != null) {
    throw new AppError(
      'The EVSE has an active or upcoming reservation. Cancel it before retiring the EVSE.',
      409,
      'EVSE_RESERVED',
    );
  }
}

async function afterChange(
  target: EvseTarget,
  change: {
    retired: boolean;
    connectorId?: number;
    notes: string;
    before: Record<string, unknown>;
    after: Record<string, unknown>;
  },
  ctx: RetireContext,
): Promise<void> {
  await writeAudit(
    { table: stationAuditLog, idColumn: 'station_id' },
    {
      entityId: target.stationDbId,
      entityIdSnapshot: target.stationDbId,
      action: 'evse_changed',
      ...ctx.actor,
      before: change.before,
      after: change.after,
      notes: change.notes,
    },
    db,
    ctx.log,
  );
  // A faulted plug that is retired no longer faults the station.
  try {
    await recomputeStationAvailability(client, target.stationDbId);
  } catch (err) {
    ctx.log.warn(
      { err, stationId: target.stationDbId },
      'Availability recompute after retire failed',
    );
  }
  // Dashboards, roaming partners (location push) and watching drivers.
  await publishStationStatusChanged({ id: target.stationDbId, siteId: target.siteId }, ctx.log);
  // The station stops or resumes charging on it. Not sent Operative to a
  // disabled station, whose disable keeps it Inoperative. Fire and forget: the
  // stored state already holds the hardware out of service.
  if (change.retired || target.disabledReason == null) {
    void sendAvailabilityCommand(
      target.stationOcppId,
      change.retired ? 'Inoperative' : 'Operative',
      ctx.log,
      {
        evseId: target.evseId,
        ...(change.connectorId != null ? { connectorId: change.connectorId } : {}),
      },
    );
  }
}

export async function retireEvse(
  stationDbId: string,
  evseId: number,
  ctx: RetireContext,
): Promise<RetireResult> {
  const target = await loadEvse(stationDbId, evseId);
  if (target.evseRetiredAt != null) return { retiredAt: target.evseRetiredAt, changed: false };
  await assertRetirable(target.evseDbId);
  const [row] = await db
    .update(evses)
    .set({ retiredAt: new Date(), updatedAt: new Date() })
    .where(and(eq(evses.id, target.evseDbId), sql`${evses.retiredAt} IS NULL`))
    .returning({ retiredAt: evses.retiredAt });
  if (row == null) {
    const again = await loadEvse(stationDbId, evseId);
    return { retiredAt: again.evseRetiredAt, changed: false };
  }
  await afterChange(
    target,
    {
      retired: true,
      notes: `EVSE ${String(evseId)} retired`,
      before: { evseId, retiredAt: null },
      after: { evseId, retiredAt: row.retiredAt },
    },
    ctx,
  );
  return { retiredAt: row.retiredAt, changed: true };
}

export async function restoreEvse(
  stationDbId: string,
  evseId: number,
  ctx: RetireContext,
): Promise<RetireResult> {
  const target = await loadEvse(stationDbId, evseId);
  const [row] = await db
    .update(evses)
    .set({ retiredAt: null, updatedAt: new Date() })
    .where(and(eq(evses.id, target.evseDbId), sql`${evses.retiredAt} IS NOT NULL`))
    .returning({ id: evses.id });
  if (row == null) return { retiredAt: null, changed: false };
  await afterChange(
    target,
    {
      retired: false,
      notes: `EVSE ${String(evseId)} restored`,
      before: { evseId, retiredAt: target.evseRetiredAt },
      after: { evseId, retiredAt: null },
    },
    ctx,
  );
  return { retiredAt: null, changed: true };
}

export async function retireConnector(
  stationDbId: string,
  evseId: number,
  connectorId: number,
  ctx: RetireContext,
): Promise<RetireResult> {
  const target = await loadEvse(stationDbId, evseId);
  const connector = await loadConnector(target, connectorId);
  if (connector.retiredAt != null) return { retiredAt: connector.retiredAt, changed: false };
  await assertRetirable(target.evseDbId, connector.id);
  const [row] = await db
    .update(connectors)
    .set({ retiredAt: new Date(), updatedAt: new Date() })
    .where(and(eq(connectors.id, connector.id), sql`${connectors.retiredAt} IS NULL`))
    .returning({ retiredAt: connectors.retiredAt });
  if (row == null) {
    const again = await loadConnector(target, connectorId);
    return { retiredAt: again.retiredAt, changed: false };
  }
  await afterChange(
    target,
    {
      retired: true,
      connectorId,
      notes: `Connector ${String(connectorId)} of EVSE ${String(evseId)} retired`,
      before: { evseId, connectorId, retiredAt: null },
      after: { evseId, connectorId, retiredAt: row.retiredAt },
    },
    ctx,
  );
  return { retiredAt: row.retiredAt, changed: true };
}

export async function restoreConnector(
  stationDbId: string,
  evseId: number,
  connectorId: number,
  ctx: RetireContext,
): Promise<RetireResult> {
  const target = await loadEvse(stationDbId, evseId);
  const connector = await loadConnector(target, connectorId);
  const [row] = await db
    .update(connectors)
    .set({ retiredAt: null, updatedAt: new Date() })
    .where(and(eq(connectors.id, connector.id), sql`${connectors.retiredAt} IS NOT NULL`))
    .returning({ id: connectors.id });
  if (row == null) return { retiredAt: null, changed: false };
  await afterChange(
    target,
    {
      retired: false,
      connectorId,
      notes: `Connector ${String(connectorId)} of EVSE ${String(evseId)} restored`,
      before: { evseId, connectorId, retiredAt: connector.retiredAt },
      after: { evseId, connectorId, retiredAt: null },
    },
    ctx,
  );
  return { retiredAt: null, changed: true };
}
