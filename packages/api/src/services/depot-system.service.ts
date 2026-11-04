// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

// Bus depot systems of the VDV 463 interface (features/vdv-463.md): create,
// change, rotate the password, delete. Every change is audited, tells the API
// processes (`depot_system.changed`, a live connection reloads or closes) and
// notifies the all-site security admins. The writer is @evtivity/database
// lib/depot-systems.ts; departures go through the departure writer.

import { and, eq } from 'drizzle-orm';
import {
  db,
  deleteDepotSystem,
  depotSiteCandidates,
  depotSystemAuditLog,
  depotSystemSiteIds,
  getDepotSystem,
  getDepotSystemByPresystemId,
  insertDepotSystem,
  releaseDepotSystemDepartures,
  setDepotSystemSites,
  updateDepotSystem as writeDepotSystem,
  userPermissions,
  users,
  writeAudit,
  type DepotSystem,
  type DepotSystemChanges,
} from '@evtivity/database';
import { DEPOT_SYSTEM_CHANGED_CHANNEL } from '../lib/depot-system-channel.js';
import { AppError, type PubSubClient, type ServiceLogger } from '@evtivity/lib';
import { getPubSub } from '@evtivity/lib/pubsub-instance';
import { usesDepotSpots } from '@evtivity/lib/site-layout';
import {
  VDV463_INFO_INTERVAL_SECONDS,
  VDV463_KEEPALIVE_TIMEOUT_SECONDS,
  VDV463_MAX_RETRIES,
  VDV463_REQUEST_TIMEOUT_SECONDS,
  type Vdv463PresystemType,
} from '@evtivity/lib/vdv463';
import { markSitePlanStale } from '@evtivity/database';
import { publishDepartureChanged } from '@evtivity/services/departure-notice.service';
import type { AuditActorInfo } from '../lib/audit-actor.js';
import {
  generateDepotSystemPassword,
  hashDepotSystemPassword,
} from '../lib/depot-system-password.js';
import { sendSecurityNotice } from '../lib/security-notice.js';

export class DepotSystemNotFoundError extends AppError {
  constructor() {
    super('Bus depot system not found', 404, 'DEPOT_SYSTEM_NOT_FOUND');
    this.name = 'DepotSystemNotFoundError';
  }
}

export class DepotSystemIdInUseError extends AppError {
  constructor() {
    super('Another bus depot system uses this system ID', 409, 'DEPOT_SYSTEM_ID_IN_USE');
    this.name = 'DepotSystemIdInUseError';
  }
}

export class DepotSystemSiteNotDepotError extends AppError {
  constructor() {
    super('A bus depot system serves depot sites only', 400, 'DEPOT_SYSTEM_SITE_NOT_DEPOT');
    this.name = 'DepotSystemSiteNotDepotError';
  }
}

/**
 * The caller's proof check refused an update that turns the system on or
 * changes its depots; the caller has already answered the request.
 */
export class DepotSystemProofRefusedError extends Error {
  constructor() {
    super('The update needs a fresh proof');
    this.name = 'DepotSystemProofRefusedError';
  }
}

export interface DepotSystemInput {
  presystemId: string;
  name: string;
  systemType: Vdv463PresystemType;
  siteIds: string[];
  isEnabled?: boolean | undefined;
  infoIntervalSeconds?: number | undefined;
  requestTimeoutSeconds?: number | undefined;
  maxRetries?: number | undefined;
  keepaliveTimeoutSeconds?: number | undefined;
}

export interface DepotSystemUpdate {
  name?: string | undefined;
  systemType?: Vdv463PresystemType | undefined;
  siteIds?: string[] | undefined;
  isEnabled?: boolean | undefined;
  infoIntervalSeconds?: number | undefined;
  requestTimeoutSeconds?: number | undefined;
  maxRetries?: number | undefined;
  keepaliveTimeoutSeconds?: number | undefined;
}

export interface DepotSystemCtx {
  actor: AuditActorInfo;
  log: ServiceLogger;
  pubsub?: PubSubClient;
}

/** The audit and API view of a depot system: never the password hash. */
export function depotSystemAuditView(s: DepotSystem, siteIds: string[]): Record<string, unknown> {
  return {
    presystemId: s.presystemId,
    name: s.name,
    systemType: s.systemType,
    isEnabled: s.isEnabled,
    infoIntervalSeconds: s.infoIntervalSeconds,
    requestTimeoutSeconds: s.requestTimeoutSeconds,
    maxRetries: s.maxRetries,
    keepaliveTimeoutSeconds: s.keepaliveTimeoutSeconds,
    siteIds,
  };
}

async function checkSites(siteIds: string[]): Promise<string[]> {
  const unique = [...new Set(siteIds)].sort();
  const rows = await depotSiteCandidates(unique);
  if (rows.length !== unique.length) throw new DepotSystemSiteNotDepotError();
  for (const row of rows) {
    const settings =
      row.layoutSettings != null && typeof row.layoutSettings === 'object'
        ? (row.layoutSettings as { siteType?: never })
        : {};
    if (!usesDepotSpots(settings)) throw new DepotSystemSiteNotDepotError();
  }
  return unique;
}

async function audit(
  id: string,
  action: 'created' | 'updated' | 'deleted' | 'password_rotated',
  before: unknown,
  after: unknown,
  ctx: DepotSystemCtx,
  options: { entityGone?: boolean; notes?: string } = {},
): Promise<void> {
  await writeAudit(
    { table: depotSystemAuditLog, idColumn: 'depot_system_id' },
    {
      entityId: options.entityGone === true ? null : id,
      entityIdSnapshot: id,
      action,
      ...ctx.actor,
      before,
      after,
      notes: options.notes ?? null,
    },
    db,
    ctx.log,
  );
}

/** The active all-site users who hold settings.integrations:write. */
async function integrationAdminIds(): Promise<string[]> {
  const rows = await db
    .selectDistinct({ id: users.id })
    .from(users)
    .innerJoin(userPermissions, eq(userPermissions.userId, users.id))
    .where(
      and(
        eq(users.isActive, true),
        eq(users.hasAllSiteAccess, true),
        eq(userPermissions.permission, 'settings.integrations:write'),
      ),
    );
  return rows.map((r) => r.id);
}

function notifyAdmins(
  system: Pick<DepotSystem, 'name' | 'presystemId'>,
  change: 'created' | 'updated' | 'deleted' | 'password_rotated',
  ctx: DepotSystemCtx,
): void {
  void integrationAdminIds()
    .then((ids) => {
      for (const userId of ids) {
        sendSecurityNotice(
          { userId },
          'security.DepotSystemChanged',
          {
            depotSystemName: system.name,
            presystemId: system.presystemId,
            created: change === 'created',
            deleted: change === 'deleted',
            passwordRotated: change === 'password_rotated',
          },
          ctx.log,
        );
      }
    })
    .catch((err: unknown) => {
      ctx.log.warn({ err }, 'Depot system notice recipients failed, the change stands');
    });
}

/** Tells every API process: a live connection reloads its system or closes. */
async function publishChanged(
  id: string,
  ctx: DepotSystemCtx,
  closeConnection: boolean,
): Promise<void> {
  try {
    await (ctx.pubsub ?? getPubSub()).publish(
      DEPOT_SYSTEM_CHANGED_CHANNEL,
      JSON.stringify({ id, close: closeConnection }),
    );
  } catch (err: unknown) {
    ctx.log.warn({ err, id }, 'Depot system change not published, connections reload on reconnect');
  }
}

function inRange(value: number | undefined, range: { min: number; max: number }): boolean {
  return (
    value === undefined || (Number.isInteger(value) && value >= range.min && value <= range.max)
  );
}

function checkTimings(input: DepotSystemUpdate): void {
  if (
    !inRange(input.infoIntervalSeconds, VDV463_INFO_INTERVAL_SECONDS) ||
    !inRange(input.requestTimeoutSeconds, VDV463_REQUEST_TIMEOUT_SECONDS) ||
    !inRange(input.maxRetries, VDV463_MAX_RETRIES) ||
    !inRange(input.keepaliveTimeoutSeconds, VDV463_KEEPALIVE_TIMEOUT_SECONDS)
  ) {
    throw new AppError('A timing is out of its range', 400, 'VALIDATION_ERROR');
  }
}

export async function createDepotSystem(
  input: DepotSystemInput,
  createdBy: string | null,
  ctx: DepotSystemCtx,
): Promise<{ system: DepotSystem; siteIds: string[]; password: string }> {
  checkTimings(input);
  const siteIds = await checkSites(input.siteIds);
  if ((await getDepotSystemByPresystemId(input.presystemId)) != null) {
    throw new DepotSystemIdInUseError();
  }
  const password = generateDepotSystemPassword();
  const passwordHash = await hashDepotSystemPassword(password);
  let system: DepotSystem;
  try {
    system = await db.transaction(async (tx) => {
      const row = await insertDepotSystem(
        {
          presystemId: input.presystemId,
          name: input.name,
          systemType: input.systemType,
          passwordHash,
          isEnabled: input.isEnabled ?? false,
          infoIntervalSeconds: input.infoIntervalSeconds ?? VDV463_INFO_INTERVAL_SECONDS.default,
          requestTimeoutSeconds:
            input.requestTimeoutSeconds ?? VDV463_REQUEST_TIMEOUT_SECONDS.default,
          maxRetries: input.maxRetries ?? VDV463_MAX_RETRIES.default,
          keepaliveTimeoutSeconds:
            input.keepaliveTimeoutSeconds ?? VDV463_KEEPALIVE_TIMEOUT_SECONDS.default,
          createdBy,
        },
        tx,
      );
      await setDepotSystemSites(row.id, siteIds, tx);
      return row;
    });
  } catch (err: unknown) {
    // A parallel create took the id first (unique index).
    if ((err as { code?: string }).code === '23505') throw new DepotSystemIdInUseError();
    throw err;
  }
  await audit(system.id, 'created', null, depotSystemAuditView(system, siteIds), ctx);
  notifyAdmins(system, 'created', ctx);
  return { system, siteIds, password };
}

/**
 * `requireProof` runs when the update turns the system on or changes its
 * depots, decided on the locked row (security review AUTH-L1): a request that
 * read the row before an admin turned the system off cannot turn it back on
 * without the proof. It answers false (and the caller replies) to refuse.
 */
export async function updateDepotSystem(
  id: string,
  update: DepotSystemUpdate,
  ctx: DepotSystemCtx,
  options: { requireProof?: () => Promise<boolean> } = {},
): Promise<{ system: DepotSystem; siteIds: string[] }> {
  checkTimings(update);
  const siteIds = update.siteIds !== undefined ? await checkSites(update.siteIds) : undefined;
  const result = await db.transaction(async (tx) => {
    const before = await getDepotSystem(id, tx, { forUpdate: true });
    if (before == null) throw new DepotSystemNotFoundError();
    const beforeSites = await depotSystemSiteIds(id, tx);
    const changes: DepotSystemChanges = {};
    if (update.name !== undefined && update.name !== before.name) changes.name = update.name;
    if (update.systemType !== undefined && update.systemType !== before.systemType) {
      changes.systemType = update.systemType;
    }
    if (update.isEnabled !== undefined && update.isEnabled !== before.isEnabled) {
      changes.isEnabled = update.isEnabled;
    }
    for (const key of [
      'infoIntervalSeconds',
      'requestTimeoutSeconds',
      'maxRetries',
      'keepaliveTimeoutSeconds',
    ] as const) {
      const value = update[key];
      if (value !== undefined && value !== before[key]) changes[key] = value;
    }
    const sitesChanged =
      siteIds !== undefined && JSON.stringify(siteIds) !== JSON.stringify(beforeSites);
    if (
      (changes.isEnabled === true || sitesChanged) &&
      options.requireProof != null &&
      !(await options.requireProof())
    ) {
      throw new DepotSystemProofRefusedError();
    }
    if (Object.keys(changes).length === 0 && !sitesChanged) {
      return {
        before,
        beforeSites,
        after: before,
        afterSites: beforeSites,
        changed: false,
        released: [] as string[],
        removedSites: [] as string[],
      };
    }
    const after =
      Object.keys(changes).length > 0 ? await writeDepotSystem(id, changes, tx) : before;
    if (after == null) throw new DepotSystemNotFoundError();
    let released: string[] = [];
    const removedSites = sitesChanged ? beforeSites.filter((s) => !siteIds.includes(s)) : [];
    if (sitesChanged) {
      await setDepotSystemSites(id, siteIds, tx);
      // Departures at a depot the system no longer serves go to the operators,
      // as on delete: the system can neither change nor Terminate them.
      released = await releaseDepotSystemDepartures(id, tx, removedSites);
    }
    return {
      before,
      beforeSites,
      after,
      afterSites: sitesChanged ? siteIds : beforeSites,
      changed: true,
      released,
      removedSites,
    };
  });
  if (result.changed) {
    await audit(
      id,
      'updated',
      depotSystemAuditView(result.before, result.beforeSites),
      depotSystemAuditView(result.after, result.afterSites),
      ctx,
      result.released.length > 0
        ? {
            notes: `${String(result.released.length)} scheduled departures at removed depots handed to the operators`,
          }
        : {},
    );
    if (result.released.length > 0) {
      for (const siteId of result.removedSites) {
        await markSitePlanStale(siteId, 'depot_system', ctx.log);
      }
      await publishDepartureChanged(result.removedSites, ctx.log);
    }
    // A disabled system, a new type or fewer sites closes the live connection,
    // so the next boot decides again; other changes reload it.
    const close =
      result.before.isEnabled !== result.after.isEnabled ||
      result.before.systemType !== result.after.systemType ||
      result.beforeSites.some((s) => !result.afterSites.includes(s));
    await publishChanged(id, ctx, close);
    notifyAdmins(result.after, 'updated', ctx);
  }
  return { system: result.after, siteIds: result.afterSites };
}

export async function rotateDepotSystemPassword(
  id: string,
  ctx: DepotSystemCtx,
): Promise<{ system: DepotSystem; password: string }> {
  const password = generateDepotSystemPassword();
  const passwordHash = await hashDepotSystemPassword(password);
  const system = await writeDepotSystem(id, { passwordHash });
  if (system == null) throw new DepotSystemNotFoundError();
  await audit(id, 'password_rotated', null, null, ctx);
  await publishChanged(id, ctx, true);
  notifyAdmins(system, 'password_rotated', ctx);
  return { system, password };
}

/**
 * Deletes a depot system. Its scheduled departures become manual ones the
 * operators own (they keep planning and can be edited), ended ones keep their
 * history. The live connection closes.
 */
export async function removeDepotSystem(
  id: string,
  ctx: DepotSystemCtx,
): Promise<{ system: DepotSystem; departuresReleased: number }> {
  const result = await db.transaction(async (tx) => {
    const system = await getDepotSystem(id, tx, { forUpdate: true });
    if (system == null) throw new DepotSystemNotFoundError();
    const siteIds = await depotSystemSiteIds(id, tx);
    const released = await releaseDepotSystemDepartures(id, tx);
    await deleteDepotSystem(id, tx);
    return { system, siteIds, released };
  });
  await audit(id, 'deleted', depotSystemAuditView(result.system, result.siteIds), null, ctx, {
    entityGone: true,
    ...(result.released.length > 0
      ? { notes: `${String(result.released.length)} scheduled departures handed to the operators` }
      : {}),
  });
  await publishChanged(id, ctx, true);
  notifyAdmins(result.system, 'deleted', ctx);
  if (result.released.length > 0) {
    for (const siteId of result.siteIds) await markSitePlanStale(siteId, 'depot_system', ctx.log);
    await publishDepartureChanged(result.siteIds, ctx.log);
  }
  return { system: result.system, departuresReleased: result.released.length };
}
