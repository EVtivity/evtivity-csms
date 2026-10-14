// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { eq, and, or, ilike, sql, gte, count, desc, ne, inArray } from 'drizzle-orm';
import type { FastifyBaseLogger } from 'fastify';
import {
  db,
  client,
  writeAudit,
  fleetAuditLog,
  pgErrorCode,
  pgConstraintName,
  PG_FOREIGN_KEY_VIOLATION,
  ACCOUNT_BILLING_MIN_VERSION,
  MEMBER_INVOICE_MIN_VERSION,
  guardVersion,
  releaseUpgradePending,
  fleetCreditLevel,
  loadFleetCreditExposure,
} from '@evtivity/database';
import type {
  AccountInvoiceRecipient,
  FleetCreditExposure,
  FleetCreditLevel,
  ReleaseUpgradePending,
} from '@evtivity/database';
import { providerSwitchStore } from '../lib/provider-switch.js';
import { AppError } from '@evtivity/lib';
import {
  notifyAccountBillingChange,
  enqueueFleetBillingFanout,
} from '@evtivity/services/fleet-billing-notice';
import type { AuditActorInfo } from '../lib/audit-actor.js';
import {
  fleets,
  fleetDrivers,
  fleetReservations,
  fleetStations,
  drivers,
  vehicles,
  chargingStations,
  chargingSessions,
  connectors,
  evses,
  sites,
  pricingGroupFleets,
  pricingGroups,
} from '@evtivity/database';
import type { PaginationParams } from '../lib/pagination.js';
import { sessionsAtSites } from '../lib/session-site-scope.js';
import { sessionCurrencySql } from '@evtivity/services/company-currency';
import {
  buildDerivedStatusSubquery,
  buildStatusReasonSubquery,
} from '@evtivity/services/station-derived-status';

/**
 * Lists fleets. Fleets are company-wide records, so every fleet is listed;
 * with `siteIds` (a site-restricted user) the station count covers only the
 * fleet's stations at those sites.
 */
export async function listFleets(params: PaginationParams, siteIds: string[] | null = null) {
  const { page, limit, search } = params;
  const offset = (page - 1) * limit;

  let where = undefined;
  if (search) {
    const pattern = `%${search}%`;
    where = or(
      ilike(fleets.id, pattern),
      ilike(fleets.name, pattern),
      ilike(fleets.description, pattern),
    );
  }

  const [data, countRows] = await Promise.all([
    db
      .select({
        id: fleets.id,
        name: fleets.name,
        description: fleets.description,
        accountBillingEnabled: fleets.accountBillingEnabled,
        createdAt: fleets.createdAt,
        updatedAt: fleets.updatedAt,
        // Correlated counts written out with aliases: a single-table select
        // renders columns unqualified, so the fleet id must name "fleets".
        driverCount: sql<number>`(select count(*) from fleet_drivers fd where fd.fleet_id = "fleets"."id")::int`,
        stationCount:
          siteIds == null
            ? sql<number>`(select count(*) from fleet_stations fs where fs.fleet_id = "fleets"."id")::int`
            : siteIds.length === 0
              ? sql<number>`0`
              : sql<number>`(select count(*) from fleet_stations fs inner join charging_stations cs on cs.id = fs.station_id where fs.fleet_id = "fleets"."id" and cs.site_id in ${siteIds})::int`,
      })
      .from(fleets)
      .where(where)
      .orderBy(desc(fleets.createdAt), desc(fleets.id))
      .limit(limit)
      .offset(offset),
    db
      .select({ count: sql<number>`count(*)::int` })
      .from(fleets)
      .where(where),
  ]);

  return { data, total: countRows[0]?.count ?? 0 };
}

export async function getFleet(id: string) {
  const [fleet] = await db.select().from(fleets).where(eq(fleets.id, id));
  return fleet ?? null;
}

/** True when the fleet is assigned to at least one pricing group. */
export async function fleetHasPricingGroup(fleetId: string): Promise<boolean> {
  const [row] = await db
    .select({ id: pricingGroupFleets.id })
    .from(pricingGroupFleets)
    .where(eq(pricingGroupFleets.fleetId, fleetId))
    .limit(1);
  return row != null;
}

export async function createFleet(data: { name: string; description?: string | undefined }) {
  const [fleet] = await db.insert(fleets).values(data).returning();
  return fleet;
}

export async function updateFleet(
  id: string,
  data: { name?: string | undefined; description?: string | undefined },
) {
  const [fleet] = await db
    .update(fleets)
    .set({ ...data, updatedAt: new Date() })
    .where(eq(fleets.id, id))
    .returning();
  return fleet ?? null;
}

const fleetHasBillingError = (): AppError =>
  new AppError(
    'The fleet has sessions billed to its account and cannot be deleted. Turn off account billing instead.',
    409,
    'FLEET_HAS_OPEN_BILLING',
  );

const fleetHasReservationsError = (): AppError =>
  new AppError(
    'The fleet has fleet reservations and cannot be deleted. Reservations are kept as history.',
    409,
    'FLEET_HAS_RESERVATIONS',
  );

/** The foreign key from fleet_reservations to fleets (no ON DELETE action). */
const FLEET_RESERVATIONS_FLEET_FK = 'fleet_reservations_fleet_id_fleets_id_fk';

/**
 * Deletes a fleet. Refused with 409 FLEET_HAS_OPEN_BILLING while sessions are
 * billed to the fleet (charging_sessions.billing_fleet_id, ON DELETE
 * RESTRICT): their billing (unbilled, invoiced, paid) stays with the fleet.
 * Refused with 409 FLEET_HAS_RESERVATIONS while a fleet reservation (any
 * status, cancelled ones included) names the fleet: reservations are history.
 * A row added between the checks and the delete trips its foreign key, mapped
 * by constraint name to the same codes.
 */
export async function deleteFleet(id: string) {
  const [billed] = await db
    .select({ id: chargingSessions.id })
    .from(chargingSessions)
    .where(eq(chargingSessions.billingFleetId, id))
    .limit(1);
  if (billed != null) throw fleetHasBillingError();
  const [booked] = await db
    .select({ id: fleetReservations.id })
    .from(fleetReservations)
    .where(eq(fleetReservations.fleetId, id))
    .limit(1);
  if (booked != null) throw fleetHasReservationsError();
  try {
    const [fleet] = await db.delete(fleets).where(eq(fleets.id, id)).returning();
    return fleet ?? null;
  } catch (err) {
    if (pgErrorCode(err) === PG_FOREIGN_KEY_VIOLATION) {
      if (pgConstraintName(err) === FLEET_RESERVATIONS_FLEET_FK) throw fleetHasReservationsError();
      throw fleetHasBillingError();
    }
    throw err;
  }
}

/**
 * A fleet billing change that older processes cannot follow is refused while
 * processes before `minVersion` may run: 409 FLEET_BILLING_OLD_PODS_CONNECTED
 * with the guard details. Turning account billing on needs v0.1.41 (older
 * processes neither stamp sessions nor keep account sessions off driver
 * invoices); invoicing each member needs v0.1.46 (older processes bill member
 * sessions on the fleet invoice and send member invoices to the fleet
 * contacts). When no older process is connected or was seen recently but the
 * worker's version watch is missing or stale, the code is
 * FLEET_BILLING_VERSION_CHECK_STALE instead: the guard cannot tell, so it
 * still refuses (fail closed), and the operator checks the worker.
 */
export class FleetBillingUpgradePendingError extends AppError {
  readonly details: ReleaseUpgradePending;
  readonly minVersion: string;

  constructor(details: ReleaseUpgradePending, minVersion: string = ACCOUNT_BILLING_MIN_VERSION) {
    const stale = details.reason === 'version_check_stale';
    super(
      stale
        ? `The worker's process version check has not run recently, so the CSMS cannot confirm that every process runs v${minVersion} or later. Check that the worker is running, then change the fleet billing.`
        : `A process older than v${minVersion} is still connected. Finish the upgrade, then change the fleet billing.`,
      409,
      stale ? 'FLEET_BILLING_VERSION_CHECK_STALE' : 'FLEET_BILLING_OLD_PODS_CONNECTED',
    );
    this.name = 'FleetBillingUpgradePendingError';
    this.details = details;
    this.minVersion = minVersion;
  }
}

/** Who changed fleet billing, for the audit log and logs. */
export interface FleetBillingContext {
  actor: AuditActorInfo;
  log: FastifyBaseLogger;
}

/** A change of a fleet's account billing: the switch, the invoice recipient, or both. */
export interface FleetAccountBillingInput {
  enabled?: boolean | undefined;
  recipient?: AccountInvoiceRecipient | undefined;
}

/**
 * The release every process must run before a change is allowed (the P11
 * rollout layer), or null: invoicing each member needs
 * MEMBER_INVOICE_MIN_VERSION, turning account billing on
 * ACCOUNT_BILLING_MIN_VERSION. Turning it off and switching back to the fleet
 * are never refused.
 */
export function fleetBillingMinVersion(change: FleetAccountBillingInput): string | null {
  if (change.recipient === 'member') return MEMBER_INVOICE_MIN_VERSION;
  if (change.enabled === true) return ACCOUNT_BILLING_MIN_VERSION;
  return null;
}

/**
 * Changes charge on account (`accountBillingEnabled`) and who the account
 * invoices go to (`accountInvoiceRecipient`: the fleet, or each member) for a
 * fleet: the only writer of both columns (P3). One transaction under the
 * fleet row lock writes only the keys that differ, so a repeated request
 * audits and notifies nothing (P7). A change older processes cannot follow
 * runs the release guard first (fleetBillingMinVersion,
 * FleetBillingUpgradePendingError). On a change: fleet_audit_log
 * `billing_updated` with the changed keys, and one fan-out to the worker
 * (fleet.AccountBillingChanged to each member whose billing the change moved),
 * never inline in the request. Started sessions keep their stamp, so a switch
 * never moves them to another recipient. Null when the fleet does not exist.
 */
export async function setFleetAccountBilling(
  fleetId: string,
  input: FleetAccountBillingInput,
  ctx: FleetBillingContext,
) {
  const result = await db.transaction(async (tx) => {
    const [current] = await tx.select().from(fleets).where(eq(fleets.id, fleetId)).for('update');
    if (current == null) return null;
    const before: Partial<
      Pick<typeof current, 'accountBillingEnabled' | 'accountInvoiceRecipient'>
    > = {};
    const after: Partial<
      Pick<typeof current, 'accountBillingEnabled' | 'accountInvoiceRecipient'>
    > = {};
    if (input.enabled !== undefined && input.enabled !== current.accountBillingEnabled) {
      before.accountBillingEnabled = current.accountBillingEnabled;
      after.accountBillingEnabled = input.enabled;
    }
    if (input.recipient !== undefined && input.recipient !== current.accountInvoiceRecipient) {
      before.accountInvoiceRecipient = current.accountInvoiceRecipient;
      after.accountInvoiceRecipient = input.recipient;
    }
    if (Object.keys(after).length === 0) return { fleet: current, diff: null };
    // Rollout rule (P11): the release guard shared with the payment provider
    // switch (process-versions.ts), only for a change older processes cannot follow.
    const minVersion = fleetBillingMinVersion({
      enabled: after.accountBillingEnabled,
      recipient: after.accountInvoiceRecipient,
    });
    if (minVersion != null) {
      const pending = await releaseUpgradePending(guardVersion(minVersion), providerSwitchStore());
      if (pending != null) throw new FleetBillingUpgradePendingError(pending, minVersion);
    }
    const [updated] = await tx
      .update(fleets)
      .set({ ...after, updatedAt: new Date() })
      .where(eq(fleets.id, fleetId))
      .returning();
    return { fleet: updated ?? current, diff: { before, after } };
  });
  if (result == null) return null;
  const { fleet, diff } = result;
  if (diff == null) return fleet;

  await writeAudit(
    { table: fleetAuditLog, idColumn: 'fleet_id' },
    {
      entityId: fleetId,
      entityIdSnapshot: fleetId,
      action: 'billing_updated',
      ...ctx.actor,
      before: diff.before,
      after: diff.after,
    },
    db,
    ctx.log,
  );

  // One fan-out per change. `recipient` only when the recipient changed (a
  // switch-only change keeps the v0.1.45 payload shape).
  const recipientChanged = diff.after.accountInvoiceRecipient !== undefined;
  await enqueueFleetBillingFanout(
    {
      fleetId,
      enabled: fleet.accountBillingEnabled,
      changedAt: fleet.updatedAt.toISOString(),
      ...(recipientChanged
        ? {
            recipient: fleet.accountInvoiceRecipient,
            enabledChanged: diff.after.accountBillingEnabled !== undefined,
          }
        : {}),
    },
    ctx.log,
  );
  return fleet;
}

/** The fleet billing profile: who the fleet invoice goes to and how. */
export interface FleetBillingProfile {
  billingContactEmails: string[];
  billingLegalName: string | null;
  billingStreet: string | null;
  billingCity: string | null;
  billingState: string | null;
  billingZip: string | null;
  billingCountry: string | null;
  billingTaxId: string | null;
  invoiceLanguage: string;
  paymentTermsDays: number | null;
  autoInvoice: boolean;
}

export type FleetBillingProfilePatch = {
  [K in keyof FleetBillingProfile]?: FleetBillingProfile[K] | undefined;
};

const PROFILE_KEYS = [
  'billingContactEmails',
  'billingLegalName',
  'billingStreet',
  'billingCity',
  'billingState',
  'billingZip',
  'billingCountry',
  'billingTaxId',
  'invoiceLanguage',
  'paymentTermsDays',
  'autoInvoice',
] as const satisfies readonly (keyof FleetBillingProfile)[];

const PROFILE_TEXT_KEYS = [
  'billingLegalName',
  'billingStreet',
  'billingCity',
  'billingState',
  'billingZip',
  'billingCountry',
  'billingTaxId',
] as const;

function pickBillingProfile(fleet: FleetBillingProfile): FleetBillingProfile {
  const profile = {} as Record<keyof FleetBillingProfile, unknown>;
  for (const key of PROFILE_KEYS) profile[key] = fleet[key];
  return profile as unknown as FleetBillingProfile;
}

/**
 * The profile after the patch: text trimmed (blank is null), contact emails
 * trimmed, lowercased and without duplicates. Keys not in the patch keep
 * their current value.
 */
export function mergeBillingProfile(
  current: FleetBillingProfile,
  patch: FleetBillingProfilePatch,
): FleetBillingProfile {
  const next: FleetBillingProfile = { ...current, billingContactEmails: [] };
  for (const key of PROFILE_TEXT_KEYS) {
    const value = patch[key];
    if (value === undefined) {
      next[key] = current[key];
    } else {
      const trimmed = value?.trim() ?? '';
      next[key] = trimmed === '' ? null : trimmed;
    }
  }
  const emails = patch.billingContactEmails ?? current.billingContactEmails;
  next.billingContactEmails = [
    ...new Set(emails.map((e) => e.trim().toLowerCase()).filter((e) => e !== '')),
  ];
  if (patch.invoiceLanguage !== undefined) next.invoiceLanguage = patch.invoiceLanguage;
  if (patch.paymentTermsDays !== undefined) next.paymentTermsDays = patch.paymentTermsDays;
  if (patch.autoInvoice !== undefined) next.autoInvoice = patch.autoInvoice;
  return next;
}

/** The keys whose value differs, with their before and after values. */
export function diffBillingProfile(
  before: FleetBillingProfile,
  after: FleetBillingProfile,
): { before: Partial<FleetBillingProfile>; after: Partial<FleetBillingProfile> } | null {
  const b: Record<string, unknown> = {};
  const a: Record<string, unknown> = {};
  for (const key of PROFILE_KEYS) {
    const same =
      key === 'billingContactEmails'
        ? before[key].join('\n') === after[key].join('\n')
        : before[key] === after[key];
    if (!same) {
      b[key] = before[key];
      a[key] = after[key];
    }
  }
  if (Object.keys(a).length === 0) return null;
  return { before: b, after: a };
}

const billingContactRequiredError = (): AppError =>
  new AppError(
    'Automatic invoicing needs at least one billing contact.',
    400,
    'FLEET_BILLING_CONTACT_REQUIRED',
  );

/**
 * Updates the fleet billing profile: the only writer of the profile columns
 * (billing contacts, bill-to, invoice language, payment terms, auto invoice;
 * P3). Keys left out keep their value. Refused with 400
 * FLEET_BILLING_CONTACT_REQUIRED when auto invoice would be on without a
 * billing contact (the check `fleets_auto_invoice_contact_check` holds the
 * same rule). Only a change is written and audited (fleet_audit_log
 * `billing_updated` with the changed keys), so a repeated request writes
 * nothing (P7). Null when the fleet does not exist.
 */
export async function updateFleetBillingProfile(
  fleetId: string,
  patch: FleetBillingProfilePatch,
  ctx: FleetBillingContext,
) {
  const result = await db.transaction(async (tx) => {
    const [current] = await tx.select().from(fleets).where(eq(fleets.id, fleetId)).for('update');
    if (current == null) return null;
    const next = mergeBillingProfile(current, patch);
    if (next.autoInvoice && next.billingContactEmails.length === 0) {
      throw billingContactRequiredError();
    }
    const diff = diffBillingProfile(pickBillingProfile(current), next);
    if (diff == null) return { fleet: current, diff };
    const [updated] = await tx
      .update(fleets)
      .set({ ...diff.after, updatedAt: new Date() })
      .where(eq(fleets.id, fleetId))
      .returning();
    return { fleet: updated ?? current, diff };
  });
  if (result == null) return null;
  if (result.diff != null) {
    await writeAudit(
      { table: fleetAuditLog, idColumn: 'fleet_id' },
      {
        entityId: fleetId,
        entityIdSnapshot: fleetId,
        action: 'billing_updated',
        ...ctx.actor,
        before: result.diff.before,
        after: result.diff.after,
      },
      db,
      ctx.log,
    );
  }
  return result.fleet;
}

/** A fleet's credit limit with its exposure now (GET and PATCH /v1/fleets/:id/credit-limit). */
export interface FleetCreditLimitView {
  creditLimitCents: number | null;
  warningPercent: number;
  exposure: FleetCreditExposure;
  /** Null when the fleet has no limit. */
  level: FleetCreditLevel | null;
}

/** The fleet's credit limit and exposure, or null when the fleet does not exist. */
export async function getFleetCreditLimit(fleetId: string): Promise<FleetCreditLimitView | null> {
  const [fleet] = await db
    .select({
      creditLimitCents: fleets.creditLimitCents,
      warningPercent: fleets.creditLimitWarningPercent,
    })
    .from(fleets)
    .where(eq(fleets.id, fleetId));
  if (fleet == null) return null;
  const exposure = await loadFleetCreditExposure(client, fleetId);
  return {
    creditLimitCents: fleet.creditLimitCents,
    warningPercent: fleet.warningPercent,
    exposure,
    level:
      fleet.creditLimitCents == null
        ? null
        : fleetCreditLevel(exposure.totalCents, fleet.creditLimitCents, fleet.warningPercent),
  };
}

/**
 * Sets the fleet's credit limit (null: none) and warning percent: the only
 * writer of fleets.credit_limit_cents and credit_limit_warning_percent (P3).
 * A start is refused while the exposure is at or above the limit; the check
 * reads the limit under the fleet row lock, so this UPDATE and a start check
 * never interleave. Runs under the same lock (SELECT ... FOR UPDATE): a value
 * left out keeps the locked row's value, so two concurrent requests that each
 * set one value never undo each other. Writes only the keys that differ; a
 * change writes fleet_audit_log `billing_updated` with the changed keys only
 * (P7: a repeated request writes and audits nothing). Null when the fleet does
 * not exist.
 */
export async function setFleetCreditLimit(
  fleetId: string,
  input: { creditLimitCents?: number | null | undefined; warningPercent?: number | undefined },
  ctx: FleetBillingContext,
): Promise<FleetCreditLimitView | null> {
  const result = await db.transaction(async (tx) => {
    const [current] = await tx
      .select({
        creditLimitCents: fleets.creditLimitCents,
        creditLimitWarningPercent: fleets.creditLimitWarningPercent,
      })
      .from(fleets)
      .where(eq(fleets.id, fleetId))
      .for('update');
    if (current == null) return null;
    const before: Partial<typeof current> = {};
    const after: Partial<typeof current> = {};
    if (
      input.creditLimitCents !== undefined &&
      input.creditLimitCents !== current.creditLimitCents
    ) {
      before.creditLimitCents = current.creditLimitCents;
      after.creditLimitCents = input.creditLimitCents;
    }
    if (
      input.warningPercent !== undefined &&
      input.warningPercent !== current.creditLimitWarningPercent
    ) {
      before.creditLimitWarningPercent = current.creditLimitWarningPercent;
      after.creditLimitWarningPercent = input.warningPercent;
    }
    if (Object.keys(after).length === 0) return { diff: null };
    await tx
      .update(fleets)
      .set({ ...after, updatedAt: new Date() })
      .where(eq(fleets.id, fleetId));
    return { diff: { before, after } };
  });
  if (result == null) return null;
  if (result.diff != null) {
    await writeAudit(
      { table: fleetAuditLog, idColumn: 'fleet_id' },
      {
        entityId: fleetId,
        entityIdSnapshot: fleetId,
        action: 'billing_updated',
        ...ctx.actor,
        before: result.diff.before,
        after: result.diff.after,
      },
      db,
      ctx.log,
    );
  }
  return getFleetCreditLimit(fleetId);
}

/**
 * Sets a member's opt-out back to card (fleet_drivers.account_billing_opt_out):
 * the only writer of the column (P3). Changes it only when it differs (P7). On
 * a change: fleet_audit_log `member_billing_opt_out_changed` and
 * fleet.AccountBillingChanged when the change moved the driver's billing.
 * Null when the driver is not a member of the fleet.
 */
export async function setMemberBillingOptOut(
  fleetId: string,
  driverId: string,
  optOut: boolean,
  ctx: FleetBillingContext,
) {
  const membership = and(eq(fleetDrivers.fleetId, fleetId), eq(fleetDrivers.driverId, driverId));
  const [updated] = await db
    .update(fleetDrivers)
    .set({ accountBillingOptOut: optOut })
    .where(and(membership, ne(fleetDrivers.accountBillingOptOut, optOut)))
    .returning();
  if (updated == null) {
    const [current] = await db.select().from(fleetDrivers).where(membership);
    return current ?? null;
  }

  await writeAudit(
    { table: fleetAuditLog, idColumn: 'fleet_id' },
    {
      entityId: fleetId,
      entityIdSnapshot: fleetId,
      action: 'member_billing_opt_out_changed',
      ...ctx.actor,
      before: { driverId, accountBillingOptOut: !optOut },
      after: { driverId, accountBillingOptOut: optOut },
    },
    db,
    ctx.log,
  );

  await notifyAccountBillingChange(client, driverId, { kind: 'optOut', fleetId, optOut }, ctx.log);
  return updated;
}

/**
 * After a member joined a fleet: the driver hears it once when the new
 * membership moved their billing (fleet.AccountBillingChanged).
 */
export async function notifyMemberJoined(
  fleetId: string,
  driverId: string,
  log: FastifyBaseLogger,
): Promise<void> {
  await notifyAccountBillingChange(client, driverId, { kind: 'joined', fleetId }, log);
}

/**
 * After a member left a fleet (`removed` is the deleted fleet_drivers row):
 * the driver hears it once when leaving moved their billing. Fail-open (P9).
 */
export async function notifyMemberLeft(
  removed: {
    id: number;
    fleetId: string;
    driverId: string;
    accountBillingOptOut: boolean;
    createdAt: Date;
  },
  log: FastifyBaseLogger,
): Promise<void> {
  const fleet = await getFleet(removed.fleetId);
  if (fleet == null) return;
  await notifyAccountBillingChange(
    client,
    removed.driverId,
    {
      kind: 'left',
      membership: {
        membershipId: removed.id,
        fleetId: removed.fleetId,
        fleetName: fleet.name,
        accountBillingEnabled: fleet.accountBillingEnabled,
        invoiceRecipient: fleet.accountInvoiceRecipient,
        optOut: removed.accountBillingOptOut,
        createdAt: removed.createdAt,
      },
    },
    log,
  );
}

export async function getFleetDrivers(fleetId: string, page: number, limit: number) {
  const offset = (page - 1) * limit;

  const [data, countRows] = await Promise.all([
    db
      .select({
        id: drivers.id,
        firstName: drivers.firstName,
        lastName: drivers.lastName,
        email: drivers.email,
        phone: drivers.phone,
        isActive: drivers.isActive,
        accountBillingOptOut: fleetDrivers.accountBillingOptOut,
        createdAt: drivers.createdAt,
      })
      .from(fleetDrivers)
      .innerJoin(drivers, eq(fleetDrivers.driverId, drivers.id))
      .where(eq(fleetDrivers.fleetId, fleetId))
      .orderBy(desc(drivers.createdAt), desc(drivers.id))
      .limit(limit)
      .offset(offset),
    db
      .select({ count: sql<number>`count(*)::int` })
      .from(fleetDrivers)
      .where(eq(fleetDrivers.fleetId, fleetId)),
  ]);

  return { data, total: countRows[0]?.count ?? 0 };
}

export async function addDriverToFleet(fleetId: string, driverId: string) {
  // Schema enforces (fleet_id, driver_id) uniqueness. ON CONFLICT DO NOTHING
  // means a duplicate add returns no row instead of erroring; the caller
  // surfaces that as a clean 409 instead of a 500 from the unique violation.
  const [record] = await db
    .insert(fleetDrivers)
    .values({ fleetId, driverId })
    .onConflictDoNothing()
    .returning();
  return record ?? null;
}

export async function removeDriverFromFleet(fleetId: string, driverId: string) {
  const [record] = await db
    .delete(fleetDrivers)
    .where(and(eq(fleetDrivers.fleetId, fleetId), eq(fleetDrivers.driverId, driverId)))
    .returning();
  return record ?? null;
}

/**
 * The fleet's stations. `siteIds` is the operator's `getUserSiteIds()`: a
 * site-restricted operator sees only the stations at its sites (null: all).
 */
export async function getFleetStations(fleetId: string, siteIds: string[] | null) {
  return db
    .select({
      id: chargingStations.id,
      stationId: chargingStations.stationId,
      siteId: chargingStations.siteId,
      model: chargingStations.model,
      securityProfile: chargingStations.securityProfile,
      ocppProtocol: chargingStations.ocppProtocol,
      status: buildDerivedStatusSubquery(chargingStations.id),
      statusReason: buildStatusReasonSubquery(chargingStations.id),
      connectorCount: sql<number>`COUNT(${connectors.id})::int`,
      connectorTypes: sql<
        string[]
      >`array_agg(DISTINCT ${connectors.connectorType}) FILTER (WHERE ${connectors.connectorType} IS NOT NULL)`,
      isOnline: chargingStations.isOnline,
      lastHeartbeat: chargingStations.lastHeartbeat,
      createdAt: chargingStations.createdAt,
    })
    .from(fleetStations)
    .innerJoin(chargingStations, eq(fleetStations.stationId, chargingStations.id))
    .leftJoin(evses, eq(evses.stationId, chargingStations.id))
    .leftJoin(connectors, eq(connectors.evseId, evses.id))
    .where(
      and(
        eq(fleetStations.fleetId, fleetId),
        siteIds != null ? inArray(chargingStations.siteId, siteIds) : undefined,
      ),
    )
    .groupBy(chargingStations.id)
    .orderBy(desc(chargingStations.createdAt), desc(chargingStations.id));
}

export async function addStationToFleet(fleetId: string, stationId: string) {
  // Same idempotency guard as addDriverToFleet — schema unique on
  // (fleet_id, station_id), so a duplicate add returns no row.
  const [record] = await db
    .insert(fleetStations)
    .values({ fleetId, stationId })
    .onConflictDoNothing()
    .returning();
  return record ?? null;
}

export async function removeStationFromFleet(fleetId: string, stationId: string) {
  const [record] = await db
    .delete(fleetStations)
    .where(and(eq(fleetStations.fleetId, fleetId), eq(fleetStations.stationId, stationId)))
    .returning();
  return record ?? null;
}

export async function getFleetVehicles(fleetId: string, page: number, limit: number) {
  const offset = (page - 1) * limit;

  const [data, countRows] = await Promise.all([
    db
      .select({
        id: vehicles.id,
        driverId: vehicles.driverId,
        driverName: sql<string>`${drivers.firstName} || ' ' || ${drivers.lastName}`,
        make: vehicles.make,
        model: vehicles.model,
        year: vehicles.year,
        vin: vehicles.vin,
        licensePlate: vehicles.licensePlate,
      })
      .from(fleetDrivers)
      .innerJoin(drivers, eq(fleetDrivers.driverId, drivers.id))
      .innerJoin(vehicles, eq(vehicles.driverId, drivers.id))
      .where(eq(fleetDrivers.fleetId, fleetId))
      .orderBy(desc(vehicles.createdAt), desc(vehicles.id))
      .limit(limit)
      .offset(offset),
    db
      .select({ count: sql<number>`count(*)::int` })
      .from(fleetDrivers)
      .innerJoin(vehicles, eq(vehicles.driverId, fleetDrivers.driverId))
      .where(eq(fleetDrivers.fleetId, fleetId)),
  ]);

  return { data, total: countRows[0]?.count ?? 0 };
}

export async function searchAvailableVehicles(fleetId: string, search: string, limit: number) {
  const fleetDriverSubquery = sql`SELECT driver_id FROM fleet_drivers WHERE fleet_id = ${fleetId}`;
  const pattern = `%${search}%`;

  return db
    .select({
      id: vehicles.id,
      driverId: vehicles.driverId,
      driverName: sql<string>`${drivers.firstName} || ' ' || ${drivers.lastName}`,
      make: vehicles.make,
      model: vehicles.model,
      year: vehicles.year,
      vin: vehicles.vin,
      licensePlate: vehicles.licensePlate,
    })
    .from(vehicles)
    .innerJoin(drivers, eq(vehicles.driverId, drivers.id))
    .where(
      and(
        sql`${vehicles.driverId} NOT IN (${fleetDriverSubquery})`,
        or(
          ilike(vehicles.make, pattern),
          ilike(vehicles.model, pattern),
          ilike(vehicles.vin, pattern),
          ilike(vehicles.licensePlate, pattern),
          ilike(drivers.firstName, pattern),
          ilike(drivers.lastName, pattern),
        ),
      ),
    )
    .orderBy(drivers.firstName)
    .limit(limit);
}

/**
 * The sessions of the fleet's drivers. `siteIds` (the operator's
 * `getUserSiteIds()`) keeps the sessions at stations of those sites; null
 * keeps all. The same scope applies to the fleet metrics and energy history.
 */
function fleetSessionFilter(fleetId: string, siteIds: string[] | null) {
  return and(
    sql`${chargingSessions.driverId} IN (select driver_id from fleet_drivers where fleet_id = ${fleetId})`,
    siteIds != null ? sessionsAtSites(siteIds) : undefined,
  );
}

export async function getFleetSessions(
  fleetId: string,
  page: number,
  limit: number,
  siteIds: string[] | null,
) {
  const offset = (page - 1) * limit;
  const driverFilter = fleetSessionFilter(fleetId, siteIds);

  const [rows, countRows] = await Promise.all([
    db
      .select({
        id: chargingSessions.id,
        stationId: chargingSessions.stationId,
        stationName: chargingStations.stationId,
        siteName: sites.name,
        transactionId: chargingSessions.transactionId,
        status: chargingSessions.status,
        startedAt: chargingSessions.startedAt,
        endedAt: chargingSessions.endedAt,
        idleStartedAt: chargingSessions.idleStartedAt,
        energyDeliveredWh: chargingSessions.energyDeliveredWh,
        currentCostCents: chargingSessions.currentCostCents,
        finalCostCents: chargingSessions.finalCostCents,
        currency: sessionCurrencySql(),
      })
      .from(chargingSessions)
      .innerJoin(chargingStations, eq(chargingSessions.stationId, chargingStations.id))
      .leftJoin(sites, eq(chargingStations.siteId, sites.id))
      .where(driverFilter)
      .orderBy(desc(chargingSessions.createdAt), desc(chargingSessions.id))
      .limit(limit)
      .offset(offset),
    db
      .select({ count: sql<number>`count(*)::int` })
      .from(chargingSessions)
      .where(driverFilter),
  ]);

  return { data: rows, total: countRows[0]?.count ?? 0 };
}

export async function getFleetMetrics(fleetId: string, months: number, siteIds: string[] | null) {
  const since = new Date();
  since.setMonth(since.getMonth() - months);

  const driverFilter = fleetSessionFilter(fleetId, siteIds);

  // Three independent aggregations — fan them in parallel so the metrics
  // endpoint is bounded by the slowest query, not the sum.
  const [[sessionStats], [driverStats], [vehicleStats]] = await Promise.all([
    db
      .select({
        totalSessions: count(),
        completedSessions: sql<number>`count(*) filter (where ${chargingSessions.status} = 'completed')`,
        faultedSessions: sql<number>`count(*) filter (where ${chargingSessions.status} = 'faulted')`,
        totalEnergyWh: sql<number>`coalesce(sum(${chargingSessions.energyDeliveredWh}::numeric), 0)`,
        avgDurationMinutes: sql<number>`coalesce(avg(extract(epoch from (${chargingSessions.endedAt} - ${chargingSessions.startedAt})) / 60) filter (where ${chargingSessions.endedAt} is not null), 0)`,
        activeDrivers: sql<number>`count(distinct ${chargingSessions.driverId})`,
      })
      .from(chargingSessions)
      .where(and(driverFilter, gte(chargingSessions.startedAt, since))),
    db
      .select({
        totalDrivers: count(),
      })
      .from(fleetDrivers)
      .where(eq(fleetDrivers.fleetId, fleetId)),
    db
      .select({
        totalVehicles: sql<number>`count(*)::int`,
      })
      .from(fleetDrivers)
      .innerJoin(vehicles, eq(vehicles.driverId, fleetDrivers.driverId))
      .where(eq(fleetDrivers.fleetId, fleetId)),
  ]);

  const total = sessionStats?.totalSessions ?? 0;
  const completed = sessionStats?.completedSessions ?? 0;

  return {
    totalSessions: total,
    completedSessions: completed,
    faultedSessions: sessionStats?.faultedSessions ?? 0,
    sessionSuccessPercent: total > 0 ? Math.round((completed / total) * 100) : 100,
    totalEnergyWh: sessionStats?.totalEnergyWh ?? 0,
    avgSessionDurationMinutes: Math.round(sessionStats?.avgDurationMinutes ?? 0),
    activeDrivers: sessionStats?.activeDrivers ?? 0,
    totalDrivers: driverStats?.totalDrivers ?? 0,
    totalVehicles: vehicleStats?.totalVehicles ?? 0,
    periodMonths: months,
  };
}

export async function getFleetEnergyHistory(
  fleetId: string,
  days: number,
  siteIds: string[] | null,
) {
  const since = new Date();
  since.setDate(since.getDate() - days);

  const driverFilter = fleetSessionFilter(fleetId, siteIds);

  const rows = await db
    .select({
      date: sql<string>`date_trunc('day', ${chargingSessions.startedAt} AT TIME ZONE 'UTC')::date::text`,
      energyWh: sql<number>`coalesce(sum(${chargingSessions.energyDeliveredWh}::numeric), 0)`,
    })
    .from(chargingSessions)
    .where(and(driverFilter, gte(chargingSessions.startedAt, since)))
    .groupBy(sql`1`)
    .orderBy(sql`1`);

  return rows.map((r) => ({ date: r.date, energyWh: r.energyWh }));
}

export async function getFleetPricingGroup(fleetId: string) {
  const rows = await db
    .select({
      id: pricingGroups.id,
      name: pricingGroups.name,
      description: pricingGroups.description,
      isDefault: pricingGroups.isDefault,
      tariffCount: sql<number>`(select count(*)::int from tariffs where tariffs.pricing_group_id = ${pricingGroups.id})`,
    })
    .from(pricingGroupFleets)
    .innerJoin(pricingGroups, eq(pricingGroupFleets.pricingGroupId, pricingGroups.id))
    .where(eq(pricingGroupFleets.fleetId, fleetId))
    .limit(1);
  return rows[0] ?? null;
}

export async function addPricingGroupToFleet(fleetId: string, pricingGroupId: string) {
  const [record] = await db
    .insert(pricingGroupFleets)
    .values({ fleetId, pricingGroupId })
    .onConflictDoUpdate({
      target: [pricingGroupFleets.fleetId],
      set: { pricingGroupId, createdAt: new Date() },
    })
    .returning();
  return record;
}

export async function removePricingGroupFromFleet(fleetId: string, pricingGroupId: string) {
  const [record] = await db
    .delete(pricingGroupFleets)
    .where(
      and(
        eq(pricingGroupFleets.fleetId, fleetId),
        eq(pricingGroupFleets.pricingGroupId, pricingGroupId),
      ),
    )
    .returning();
  return record ?? null;
}
