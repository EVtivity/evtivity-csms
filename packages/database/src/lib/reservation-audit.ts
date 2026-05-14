// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { reservationAuditLog } from '../schema/audit.js';
import { db as defaultDb } from '../config.js';
import { writeAudit } from './audit.js';

// Structural type covering both the pool-scoped db and a transaction handle.
// Both expose `insert(...)`; only the pool has `$client`. Typing the helper
// against the full pool type forces callers inside `db.transaction(tx => ...)`
// to cast, which obscures intent. Pick what we use.
type AuditDb = Pick<typeof defaultDb, 'insert'>;

export type ReservationAuditAction =
  | 'created'
  | 'updated'
  | 'cancelled'
  | 'expired'
  | 'used'
  | 'session_failed';

export type ReservationAuditActor = 'operator' | 'driver' | 'system';

export interface WriteReservationAuditArgs {
  reservationId: string;
  action: ReservationAuditAction;
  actor: ReservationAuditActor;
  actorUserId?: string | null;
  actorDriverId?: string | null;
  driverIdBefore?: string | null;
  driverIdAfter?: string | null;
  tokenIdBefore?: string | null;
  tokenIdAfter?: string | null;
  evseIdBefore?: string | null;
  evseIdAfter?: string | null;
  statusBefore?: string | null;
  statusAfter?: string | null;
  expiresAtBefore?: Date | null;
  expiresAtAfter?: Date | null;
  notes?: string | null;
}

/**
 * Shared writer for `reservation_audit_log`. Every package that mutates a
 * reservation (api, worker, ocpp) calls this so the audit log is the single
 * source of truth for reservation lifecycle events.
 *
 * Thin wrapper over `writeAudit`. The legacy per-field columns
 * (driver_id_before / _after, token_id_before / _after, ...) were collapsed
 * into the unified `before` / `after` JSONB columns by migration 0035. We
 * still accept the same caller shape for ergonomics and pack the fields into
 * the JSONB here.
 *
 * The optional db arg accepts a transaction-scoped Drizzle instance; default
 * uses the shared connection pool from @evtivity/database.
 */
export async function writeReservationAudit(
  args: WriteReservationAuditArgs,
  db: AuditDb = defaultDb,
  logger?: { warn: (obj: unknown, msg?: string) => void },
): Promise<void> {
  const hasBefore =
    args.driverIdBefore !== undefined ||
    args.tokenIdBefore !== undefined ||
    args.evseIdBefore !== undefined ||
    args.statusBefore !== undefined ||
    args.expiresAtBefore !== undefined;
  const hasAfter =
    args.driverIdAfter !== undefined ||
    args.tokenIdAfter !== undefined ||
    args.evseIdAfter !== undefined ||
    args.statusAfter !== undefined ||
    args.expiresAtAfter !== undefined;

  const before = hasBefore
    ? {
        driverId: args.driverIdBefore ?? null,
        tokenId: args.tokenIdBefore ?? null,
        evseId: args.evseIdBefore ?? null,
        status: args.statusBefore ?? null,
        expiresAt: args.expiresAtBefore ?? null,
      }
    : null;
  const after = hasAfter
    ? {
        driverId: args.driverIdAfter ?? null,
        tokenId: args.tokenIdAfter ?? null,
        evseId: args.evseIdAfter ?? null,
        status: args.statusAfter ?? null,
        expiresAt: args.expiresAtAfter ?? null,
      }
    : null;

  await writeAudit(
    { table: reservationAuditLog, idColumn: 'reservation_id' },
    {
      entityId: args.reservationId,
      entityIdSnapshot: args.reservationId,
      action: args.action,
      actor: args.actor,
      actorUserId: args.actorUserId ?? null,
      actorDriverId: args.actorDriverId ?? null,
      before,
      after,
      notes: args.notes ?? null,
    },
    db,
    logger,
  );
}

/**
 * Return true when the PATCH diff actually changed at least one of the
 * audited fields. PATCH never mutates status (status transitions go through
 * cancel/expire/use code paths, not PATCH), so we don't compare it here --
 * a PATCH-induced status change is impossible by construction.
 */
export function reservationDiffChanged(
  before: {
    driverId?: string | null;
    tokenId?: string | null;
    evseId?: string | null;
    expiresAt?: Date | null;
  },
  after: {
    driverId?: string | null;
    tokenId?: string | null;
    evseId?: string | null;
    expiresAt?: Date | null;
  },
): boolean {
  const expiresBefore = before.expiresAt == null ? null : before.expiresAt.getTime();
  const expiresAfter = after.expiresAt == null ? null : after.expiresAt.getTime();
  return (
    (before.driverId ?? null) !== (after.driverId ?? null) ||
    (before.tokenId ?? null) !== (after.tokenId ?? null) ||
    (before.evseId ?? null) !== (after.evseId ?? null) ||
    expiresBefore !== expiresAfter
  );
}
