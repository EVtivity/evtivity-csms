// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import type postgres from 'postgres';
import argon2 from 'argon2';
import { sql as dsql } from 'drizzle-orm';
import {
  DEFAULT_TAX_BASIS,
  FLEET_MANAGER_ROLE_NAME,
  FLEET_USER_PERMISSIONS,
  chargedCostBreakdown,
  computeSessionElectricityCost,
  taxTotals,
} from '@evtivity/lib';
import type { TaxLine } from '@evtivity/lib';
import { db } from './config.js';
import { writeAudit } from './lib/audit.js';
import { createId } from './lib/id.js';
import { fleetAuditLog, tokenAuditLog, userAuditLog } from './schema/audit.js';
import { loadElectricityRatePeriodsForSite } from './lib/electricity-rate.js';
import { allocateInvoiceNumber } from './lib/invoice-number.js';
import { sessionSiteIdSql } from './lib/session-site.js';
import { loadFleetCreditExposure } from './lib/fleet-credit-limit.js';
import {
  fleetHistoryBudget,
  fleetHistoryCandidates,
  selectFleetHistory,
} from './seed-fleet-history-plan.js';
import type { FleetHistoryBusy, FleetHistoryPayerSlot } from './seed-fleet-history-plan.js';

// Demo data of fleet account billing (charge on account, features/fleet-billing.md):
// one fleet that bills its members on account, with a billing profile and a
// credit limit, three members (one opted out and pays by card), unbilled
// account sessions this month, the issued fleet invoice of last month, and the
// invoice of the month before, credited in full by a credit note whose
// sessions last month's invoice billed again. Fixed ids and ON CONFLICT DO
// NOTHING on every insert, so a rerun changes nothing (P7). The invoice and
// credit note numbers come from the gap-free counter (allocateInvoiceNumber),
// allocated only for an invoice id that does not exist yet and in the same
// transaction as its insert, so a rerun allocates nothing.

/** A concurrent seed inserted the invoice first: roll back to give its number back. */
class DemoInvoiceExists extends Error {}

export const DAY_MS = 86_400_000;
export const HOUR_MS = 3_600_000;
/** Distance from a UTC month edge that keeps an instant in that month in every timezone. */
export const MONTH_EDGE_MS = 14 * HOUR_MS;

/** The fixed ids of the fleet billing demo (screenshots and tests look them up). */
export const FLEET_BILLING_DEMO = {
  fleetId: 'flt_demoacct0001',
  /** Billed on account; the portal screenshots sign in as this driver. */
  accountDriverId: 'drv_demoacct0001',
  accountDriverEmail: 'fleet.driver@evtivity.local',
  secondDriverId: 'drv_demoacct0002',
  /** Opted out of charge on account: pays by card. */
  optedOutDriverId: 'drv_demoacct0003',
  /** Issued fleet invoice of last month. */
  invoiceId: 'inv_demoacct0001',
  /** Fleet invoice of the month before last, credited in full. */
  creditedInvoiceId: 'inv_demoacct0002',
  /** Credit note of creditedInvoiceId. */
  creditNoteId: 'inv_demoacct0003',
  /** First unbilled account session of this month (session billing badge). */
  unbilledSessionId: 'ses_demoacct0001',
  /** CSMS fleet user (Fleet Manager role, Fleets access) assigned to this fleet. */
  fleetUserEmail: 'fleet@evtivity.local',
  /** The fleet user's email of earlier demo seeds, renamed once by a rerun. */
  previousFleetUserEmail: 'fleet.manager@example.com',
  /** Fleet RFID card no member holds: charges on account to the fleet. */
  poolCardId: 'dtk_demofleet001',
  /** Fleet RFID card the fleet gave to its first member. */
  memberCardId: 'dtk_demofleet002',
} as const;

/** Sign-in password of the demo fleet user, like the seeded admin and driver. */
export const DEMO_FLEET_USER_PASSWORD = 'fleet123';

/** The password earlier demo seeds gave the fleet user (the demo operator password). */
const PREVIOUS_FLEET_USER_PASSWORD = 'admin123';

/**
 * Moves the fleet user of an earlier demo seed to the current sign-in: the
 * email only while it is still the earlier demo value and the new one is
 * free, the password only while it is still the earlier demo password or
 * empty. Audited as an update. Returns whether a user was renamed.
 */
async function renameEarlierDemoFleetUser(sql: postgres.Sql): Promise<boolean> {
  const demo = FLEET_BILLING_DEMO;
  const [user] = await sql<{ id: string; password_hash: string | null }[]>`
    SELECT id, password_hash FROM users
    WHERE email = ${demo.previousFleetUserEmail} AND access_scope = 'fleets'
      AND NOT EXISTS (SELECT 1 FROM users WHERE email = ${demo.fleetUserEmail})
  `;
  if (user == null) return false;
  const stored = user.password_hash ?? '';
  const resetPassword =
    stored === '' || (await argon2.verify(stored, PREVIOUS_FLEET_USER_PASSWORD).catch(() => false));
  const passwordHash = resetPassword ? await argon2.hash(DEMO_FLEET_USER_PASSWORD) : null;
  const renamed = await sql<{ id: string }[]>`
    UPDATE users
    SET email = ${demo.fleetUserEmail},
        password_hash = COALESCE(${passwordHash}::text, password_hash),
        updated_at = now()
    WHERE id = ${user.id} AND email = ${demo.previousFleetUserEmail}
    RETURNING id
  `;
  if (renamed.length === 0) return false;
  await writeAudit(
    { table: userAuditLog, idColumn: 'user_id' },
    {
      entityId: user.id,
      entityIdSnapshot: user.id,
      action: 'updated',
      actor: 'system',
      before: { email: demo.previousFleetUserEmail },
      after: { email: demo.fleetUserEmail, passwordReset: resetPassword },
      notes: 'Demo data: fleet user sign-in moved to the current demo account',
    },
  );
  return true;
}

const FLEET_CARDS = [
  {
    id: FLEET_BILLING_DEMO.poolCardId,
    idToken: 'NWPOOLCARD01',
    label: 'Pool Van Card',
    driverId: null,
  },
  {
    id: FLEET_BILLING_DEMO.memberCardId,
    idToken: 'NWMEMBERCARD01',
    label: 'Van 2 Card',
    driverId: FLEET_BILLING_DEMO.accountDriverId,
  },
] as const;

const FLEET_NAME = 'Northwind Logistics';
const TAX_RATE = 0.08;
/** Room for a month of delivery van charging on account under the history exposure cap. */
export const CREDIT_LIMIT_CENTS = 500_000;
/** The credit limit earlier demo seeds gave the fleet, raised once by a rerun. */
export const PREVIOUS_CREDIT_LIMIT_CENTS = 50_000;
const PAYMENT_TERMS_DAYS = 14;

const BILL_TO = {
  name: 'Northwind Logistics Inc.',
  street: '400 Harbor Way',
  city: 'Albany',
  state: 'NY',
  zip: '12207',
  country: 'United States',
  taxId: 'US-84-1234567',
};

const MEMBERS = [
  {
    id: FLEET_BILLING_DEMO.accountDriverId,
    firstName: 'Morgan',
    lastName: 'Lee',
    email: FLEET_BILLING_DEMO.accountDriverEmail,
    optOut: false,
  },
  {
    id: FLEET_BILLING_DEMO.secondDriverId,
    firstName: 'Priya',
    lastName: 'Shah',
    email: 'priya.shah@northwind.example',
    optOut: false,
  },
  {
    id: FLEET_BILLING_DEMO.optedOutDriverId,
    firstName: 'Daniel',
    lastName: 'Ortiz',
    email: 'daniel.ortiz@northwind.example',
    optOut: true,
  },
] as const;

/** Sign-in password of the demo members, the demo driver password of seed.ts. */
const MEMBER_PASSWORD = 'driver123';

export interface FleetBillingDemoInput {
  /** charging_stations.id of a demo station the sessions ran on. */
  stationId: string;
  evseId: string | null;
  currency: string;
  now: Date;
}

interface DemoSession {
  id: string;
  transactionId: string;
  driverIndex: 0 | 1;
  startedAt: Date;
  endedAt: Date;
  energyWh: number;
  costCents: number;
  invoiceId: string | null;
}

export function pad(n: number): string {
  return String(n).padStart(4, '0');
}

/** An amount with a sign, never -0 (a credit note negates its invoice). */
export function signed(cents: number, sign: 1 | -1): number {
  return sign === 1 ? cents : 0 - cents;
}

/** First and last day (YYYY-MM-DD) of the UTC month `offset` months before `now`. */
export function monthBounds(
  now: Date,
  offset: number,
): { start: string; end: string; startsAt: Date } {
  const startsAt = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - offset, 1));
  const last = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - offset + 1, 0));
  return {
    start: startsAt.toISOString().slice(0, 10),
    end: last.toISOString().slice(0, 10),
    startsAt,
  };
}

/** The demo sessions: two months ago (credited, re-billed), last month (invoiced), this month (unbilled). */
export function fleetBillingDemoSessions(now: Date): DemoSession[] {
  const sessions: DemoSession[] = [];
  let n = 0;
  const add = (
    driverIndex: 0 | 1,
    startedAt: Date,
    energyWh: number,
    costCents: number,
    invoiceId: string | null,
  ): void => {
    n += 1;
    sessions.push({
      id: `ses_demoacct${pad(n)}`,
      transactionId: `txn_acct_${pad(n)}`,
      driverIndex,
      startedAt,
      endedAt: new Date(startedAt.getTime() + 75 * 60_000),
      energyWh,
      costCents,
      invoiceId,
    });
  };
  // This month: unbilled, spread between the first of the month and now. The
  // months are UTC months, while fleet invoices bill months of the system
  // timezone: the first session starts 14 hours into the UTC month, so it is in
  // the same month in every timezone (UTC-12 to UTC+14), never in last month's
  // invoiced period.
  const monthStart = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1) + MONTH_EDGE_MS;
  const span = Math.max(now.getTime() - 2 * HOUR_MS - monthStart, HOUR_MS);
  for (const [i, driver] of ([0, 1, 0, 1] as const).entries()) {
    const startedAt = new Date(monthStart + Math.floor((span * i) / 4));
    add(driver, startedAt, 18_000 + i * 4_500, 1_620 + i * 410, null);
  }
  // Last month: billed by the issued invoice of last month.
  const lastMonth = monthBounds(now, 1).startsAt.getTime();
  for (const [i, driver] of ([0, 0, 1] as const).entries()) {
    add(
      driver,
      new Date(lastMonth + (3 + i * 8) * DAY_MS + 9 * HOUR_MS),
      22_000 + i * 3_000,
      1_980 + i * 270,
      FLEET_BILLING_DEMO.invoiceId,
    );
  }
  // The month before: its invoice was credited, so last month's invoice billed them again.
  const twoMonths = monthBounds(now, 2).startsAt.getTime();
  for (const [i, driver] of ([0, 1] as const).entries()) {
    add(
      driver,
      new Date(twoMonths + (6 + i * 10) * DAY_MS + 14 * HOUR_MS),
      26_000 + i * 2_000,
      2_340 + i * 180,
      FLEET_BILLING_DEMO.invoiceId,
    );
  }
  return sessions;
}

/**
 * The demo fleet user: Fleet Manager role, Fleets access, assigned to the demo
 * fleet. Inserted when missing; an existing user keeps every column, its
 * permissions and its fleets (a rerun adds nothing).
 */
async function seedDemoFleetUser(sql: postgres.Sql): Promise<'created' | 'renamed' | 'present'> {
  const demo = FLEET_BILLING_DEMO;
  const [role] = await sql<{ id: string }[]>`
    SELECT id FROM roles WHERE name = ${FLEET_MANAGER_ROLE_NAME}
  `;
  if (role == null) throw new Error(`Role ${FLEET_MANAGER_ROLE_NAME} is missing`);
  if (await renameEarlierDemoFleetUser(sql)) return 'renamed';
  const passwordHash = await argon2.hash(DEMO_FLEET_USER_PASSWORD);
  const created = await sql<{ id: string }[]>`
    INSERT INTO users (id, email, password_hash, first_name, last_name, role_id,
      has_all_site_access, access_scope)
    VALUES (${createId('user')}, ${demo.fleetUserEmail}, ${passwordHash}, 'Riley', 'Chen',
      ${role.id}, false, 'fleets')
    ON CONFLICT (email) DO NOTHING
    RETURNING id
  `;
  const user = created[0];
  if (user == null) return 'present';
  for (const permission of FLEET_USER_PERMISSIONS) {
    await sql`
      INSERT INTO user_permissions (user_id, permission)
      VALUES (${user.id}, ${permission})
      ON CONFLICT DO NOTHING
    `;
  }
  await sql`
    INSERT INTO user_fleet_assignments (id, user_id, fleet_id)
    VALUES (${createId('userFleetAssignment')}, ${user.id}, ${demo.fleetId})
    ON CONFLICT (user_id, fleet_id) DO NOTHING
  `;
  await writeAudit(
    { table: userAuditLog, idColumn: 'user_id' },
    {
      entityId: user.id,
      entityIdSnapshot: user.id,
      action: 'created',
      actor: 'system',
      before: null,
      after: {
        email: demo.fleetUserEmail,
        role: FLEET_MANAGER_ROLE_NAME,
        accessScope: 'fleets',
        fleetIds: [demo.fleetId],
        permissions: [...FLEET_USER_PERMISSIONS],
      },
      notes: 'Demo data: fleet user',
    },
  );
  return 'created';
}

/**
 * Two fleet RFID cards: one no member holds and one given to the first
 * member. Inserted when missing, each with its token audit row; a rerun, or
 * a card value another token already holds, adds nothing.
 */
async function seedDemoFleetCards(sql: postgres.Sql): Promise<number> {
  let created = 0;
  for (const card of FLEET_CARDS) {
    const inserted = await sql<{ id: string }[]>`
      INSERT INTO driver_tokens (id, driver_id, fleet_id, id_token, token_type, label, is_active)
      SELECT ${card.id}, ${card.driverId}::text, ${FLEET_BILLING_DEMO.fleetId}, ${card.idToken},
        'ISO14443', ${card.label}, true
      WHERE ${card.driverId}::text IS NULL
         OR EXISTS (SELECT 1 FROM drivers WHERE id = ${card.driverId}::text)
      ON CONFLICT DO NOTHING
      RETURNING id
    `;
    if (inserted.length === 0) continue;
    created += 1;
    await writeAudit(
      { table: tokenAuditLog, idColumn: 'token_id' },
      {
        entityId: card.id,
        entityIdSnapshot: card.id,
        action: 'created',
        actor: 'system',
        before: null,
        after: {
          idToken: card.idToken,
          tokenType: 'ISO14443',
          fleetId: FLEET_BILLING_DEMO.fleetId,
          driverId: card.driverId,
          label: card.label,
          isActive: true,
        },
        notes: 'Demo data: fleet RFID card',
      },
    );
  }
  return created;
}

/** What one run of the fleet user demo created. */
export interface FleetUserDemoCounts {
  /** What this run did with the demo fleet user; `no_fleet` without the demo fleet. */
  fleetUser: 'created' | 'renamed' | 'present' | 'no_fleet';
  fleetCards: number;
}

/**
 * The demo fleet user and the two demo fleet RFID cards of the Northwind demo
 * fleet (found by its fixed id). Runs on every demo seed and rerun, so an
 * install seeded before they existed gets them; nothing while the fleet is
 * missing (no demo), and nothing again once they exist.
 */
export async function seedFleetUsersDemo(sql: postgres.Sql): Promise<FleetUserDemoCounts> {
  const [fleet] = await sql<{ id: string }[]>`
    SELECT id FROM fleets WHERE id = ${FLEET_BILLING_DEMO.fleetId}
  `;
  if (fleet == null) return { fleetUser: 'no_fleet', fleetCards: 0 };
  const fleetUser = await seedDemoFleetUser(sql);
  const fleetCards = await seedDemoFleetCards(sql);
  return { fleetUser, fleetCards };
}

/** Seeds the fleet billing demo. Returns the number of sessions it inserted. */
export async function seedFleetBillingDemo(
  sql: postgres.Sql,
  input: FleetBillingDemoInput,
): Promise<number> {
  const { now, currency } = input;
  const demo = FLEET_BILLING_DEMO;

  await sql`
    INSERT INTO fleets (id, name, description, account_billing_enabled, billing_contact_emails,
      billing_legal_name, billing_street, billing_city, billing_state, billing_zip,
      billing_country, billing_tax_id, invoice_language, payment_terms_days, auto_invoice,
      credit_limit_cents, credit_limit_warning_percent)
    VALUES (${demo.fleetId}, ${FLEET_NAME}, ${'Delivery vans charged on account'}, true,
      ${['ap@northwind.example']}, ${BILL_TO.name}, ${BILL_TO.street}, ${BILL_TO.city},
      ${BILL_TO.state}, ${BILL_TO.zip}, ${BILL_TO.country}, ${BILL_TO.taxId}, 'en',
      ${PAYMENT_TERMS_DAYS}, false, ${CREDIT_LIMIT_CENTS}, 80)
    ON CONFLICT (id) DO NOTHING
  `;

  const memberPasswordHash = await argon2.hash(MEMBER_PASSWORD);
  for (const [i, member] of MEMBERS.entries()) {
    await sql`
      INSERT INTO drivers (id, first_name, last_name, email, registration_source, is_active,
        email_verified, created_at)
      VALUES (${member.id}, ${member.firstName}, ${member.lastName}, ${member.email}, 'admin',
        true, true, ${new Date(now.getTime() - (120 - i) * DAY_MS)})
      ON CONFLICT (id) DO NOTHING
    `;
    // Sign-in for the portal and the app. Only where no password is set, so a
    // rerun or a password the driver chose stays untouched.
    await sql`
      UPDATE drivers SET password_hash = ${memberPasswordHash}
      WHERE id = ${member.id} AND password_hash IS NULL
    `;
    await sql`
      INSERT INTO fleet_drivers (fleet_id, driver_id, account_billing_opt_out, created_at)
      VALUES (${demo.fleetId}, ${member.id}, ${member.optOut},
        ${new Date(now.getTime() - (100 - i) * DAY_MS)})
      ON CONFLICT (fleet_id, driver_id) DO NOTHING
    `;
  }

  await seedFleetUsersDemo(sql);

  const place = await loadDemoStationPlace(sql, input.stationId);

  // Invoices first: the sessions reference them.
  const sessions = fleetBillingDemoSessions(now);
  const invoiced = sessions.filter((s) => s.invoiceId === demo.invoiceId);
  const lastMonth = monthBounds(now, 1);
  const twoMonths = monthBounds(now, 2);
  const credited = invoiced.filter((s) => s.startedAt.getTime() < lastMonth.startsAt.getTime());
  const invoiceIssuedAt = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1, 9));
  const creditedIssuedAt = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - 1, 1, 9));
  const creditNoteIssuedAt = new Date(creditedIssuedAt.getTime() + 9 * DAY_MS);
  const header = {
    fleetId: demo.fleetId,
    driverId: null,
    memberBilled: false,
    billTo: BILL_TO,
    language: 'en',
    currency,
    paymentTermsDays: PAYMENT_TERMS_DAYS,
    taxRate: TAX_RATE,
  };
  // Fleet invoice lines are grouped by driver (driver order, then end time).
  const lineSessions = (list: DemoSession[]): DemoLineSession[] =>
    [...list]
      .sort((a, b) => a.driverIndex - b.driverIndex || a.endedAt.getTime() - b.endedAt.getTime())
      .map((session) => {
        const member = MEMBERS[session.driverIndex];
        return {
          id: session.id,
          endedAt: session.endedAt,
          energyWh: session.energyWh,
          costCents: session.costCents,
          driverId: member.id,
          driverName: `${member.firstName} ${member.lastName}`,
        };
      });

  // The credited invoice must exist before its credit note; the credit note
  // before the re-billing invoice is not required, but keeps the issue order.
  await insertDemoInvoice(sql, demo.creditedInvoiceId, {
    ...header,
    kind: 'invoice',
    status: 'credited',
    issuedAt: creditedIssuedAt,
    period: twoMonths,
    sessions: lineSessions(credited),
    sign: 1,
    creditedInvoiceId: null,
    creditReason: null,
  });
  await insertDemoInvoice(sql, demo.creditNoteId, {
    ...header,
    kind: 'credit_note',
    status: 'issued',
    issuedAt: creditNoteIssuedAt,
    period: twoMonths,
    sessions: lineSessions(credited),
    sign: -1,
    creditedInvoiceId: demo.creditedInvoiceId,
    creditReason: 'Wrong tariff applied; the sessions are billed again on the next invoice',
  });
  await insertDemoInvoice(sql, demo.invoiceId, {
    ...header,
    kind: 'invoice',
    status: 'issued',
    issuedAt: invoiceIssuedAt,
    period: lastMonth,
    sessions: lineSessions(invoiced),
    sign: 1,
    creditedInvoiceId: null,
    creditReason: null,
  });

  let inserted = 0;
  for (const session of sessions) {
    inserted += await insertDemoAccountSession(sql, {
      ...session,
      stationId: input.stationId,
      evseId: input.evseId,
      driverId: MEMBERS[session.driverIndex].id,
      fleetId: demo.fleetId,
      memberBilled: false,
      taxRate: TAX_RATE,
      currency,
      electricityCostCents: place.electricityCostOf(session.endedAt, session.energyWh),
    });
  }

  for (const [invoiceId, list, sign] of [
    [demo.creditedInvoiceId, credited, 1],
    [demo.creditNoteId, credited, -1],
    [demo.invoiceId, invoiced, 1],
  ] as const) {
    await insertDemoLineItems(sql, invoiceId, lineSessions(list), sign, {
      stationName: place.stationName,
      taxRate: TAX_RATE,
    });
  }

  return inserted;
}

// ---------- Rolling charging history of the Northwind fleet ----------

/**
 * Raises the credit limit of the demo fleet from the value earlier demo seeds
 * wrote, only while the fleet still holds it and no one ever changed the
 * limit (no `billing_updated` row naming it), audited as a billing update.
 * Returns whether it raised the limit.
 */
async function raiseEarlierDemoCreditLimit(sql: postgres.Sql): Promise<boolean> {
  const fleetId = FLEET_BILLING_DEMO.fleetId;
  const raised = await sql<{ id: string }[]>`
    UPDATE fleets SET credit_limit_cents = ${CREDIT_LIMIT_CENTS}, updated_at = now()
    WHERE id = ${fleetId} AND credit_limit_cents = ${PREVIOUS_CREDIT_LIMIT_CENTS}
      AND NOT EXISTS (
        SELECT 1 FROM fleet_audit_log a
        WHERE a.fleet_id = ${fleetId} AND a.action = 'billing_updated'
          AND jsonb_exists(coalesce(a.after, '{}'::jsonb), 'creditLimitCents'))
    RETURNING id
  `;
  if (raised.length === 0) return false;
  await writeAudit(
    { table: fleetAuditLog, idColumn: 'fleet_id' },
    {
      entityId: fleetId,
      entityIdSnapshot: fleetId,
      action: 'billing_updated',
      actor: 'system',
      before: { creditLimitCents: PREVIOUS_CREDIT_LIMIT_CENTS },
      after: { creditLimitCents: CREDIT_LIMIT_CENTS },
      notes: 'Demo data: credit limit raised for the rolling charging history',
    },
  );
  return true;
}

/** What one run of the fleet history demo did. */
export interface FleetHistoryCounts {
  sessions: number;
  skippedBusy: number;
  skippedBudget: number;
  creditLimitRaised: boolean;
}

const NO_HISTORY: FleetHistoryCounts = {
  sessions: 0,
  skippedBusy: 0,
  skippedBudget: 0,
  creditLimitRaised: false,
};

/** Who each payer slot is, from the demo cards and members that exist and still charge on account. */
async function loadHistoryPayers(
  sql: postgres.Sql,
): Promise<Map<FleetHistoryPayerSlot, { driverId: string | null; tokenId: string | null }>> {
  const demo = FLEET_BILLING_DEMO;
  const cards = await sql<{ id: string; driver_id: string | null }[]>`
    SELECT id, driver_id FROM driver_tokens
    WHERE id IN (${demo.poolCardId}, ${demo.memberCardId}) AND fleet_id = ${demo.fleetId}
      AND is_active
  `;
  const members = await sql<{ driver_id: string }[]>`
    SELECT fd.driver_id FROM fleet_drivers fd JOIN drivers d ON d.id = fd.driver_id
    WHERE fd.fleet_id = ${demo.fleetId} AND NOT fd.account_billing_opt_out AND d.is_active
      AND fd.driver_id IN (${demo.accountDriverId}, ${demo.secondDriverId})
  `;
  const memberIds = new Set(members.map((m) => m.driver_id));
  const payers = new Map<
    FleetHistoryPayerSlot,
    { driverId: string | null; tokenId: string | null }
  >();
  const pool = cards.find((c) => c.id === demo.poolCardId);
  if (pool != null && pool.driver_id == null)
    payers.set('poolCard', { driverId: null, tokenId: pool.id });
  const member = cards.find((c) => c.id === demo.memberCardId);
  if (member?.driver_id != null && memberIds.has(member.driver_id)) {
    payers.set('memberCard', { driverId: member.driver_id, tokenId: member.id });
  }
  if (memberIds.has(demo.accountDriverId)) {
    payers.set('accountDriver', { driverId: demo.accountDriverId, tokenId: null });
  }
  if (memberIds.has(demo.secondDriverId)) {
    payers.set('secondDriver', { driverId: demo.secondDriverId, tokenId: null });
  }
  return payers;
}

/**
 * Tops the Northwind fleet's charging history up to the last 30 days
 * (seed-fleet-history-plan.ts): completed sessions billed on account to the
 * fleet through its cards and members, on the station of its seeded demo
 * sessions, never overlapping a session on the same EVSE. Under the fleet
 * row lock, as a credit check reads it, the sessions stop where the fleet's
 * exposure would pass FLEET_HISTORY.exposureCapPercent of its limit. Ids
 * are fixed per day, so a rerun inserts only what is missing and never
 * changes an existing session. Nothing while the demo fleet or its seeded
 * sessions are missing.
 */
export async function seedFleetAccountHistory(
  sql: postgres.Sql,
  input: { now: Date; currency: string },
): Promise<FleetHistoryCounts> {
  const demo = FLEET_BILLING_DEMO;
  const [fleet] = await sql<{ id: string }[]>`SELECT id FROM fleets WHERE id = ${demo.fleetId}`;
  if (fleet == null) return NO_HISTORY;
  const creditLimitRaised = await raiseEarlierDemoCreditLimit(sql);
  const [anchor] = await sql<{ station_id: string }[]>`
    SELECT station_id FROM charging_sessions
    WHERE left(id, 12) = 'ses_demoacct' AND billing_fleet_id = ${demo.fleetId}
    ORDER BY id LIMIT 1
  `;
  if (anchor == null) return { ...NO_HISTORY, creditLimitRaised };
  const stationId = anchor.station_id;
  const evses = await sql<{ id: string; kw: string | null }[]>`
    SELECT e.id, max(c.max_power_kw)::text AS kw
    FROM evses e LEFT JOIN connectors c ON c.evse_id = e.id
    WHERE e.station_id = ${stationId} AND e.retired_at IS NULL
    GROUP BY e.id, e.evse_id ORDER BY e.evse_id
  `;
  const payers = await loadHistoryPayers(sql);
  if (payers.size === 0) return { ...NO_HISTORY, creditLimitRaised };
  const fallback = [...payers.values()];
  const stationKw = Math.max(0, ...evses.map((e) => Number(e.kw ?? 0)));
  const candidates = fleetHistoryCandidates(input.now, stationKw);
  if (candidates.length === 0) return { ...NO_HISTORY, creditLimitRaised };
  const place = await loadDemoStationPlace(sql, stationId);
  const windowStart = candidates[0]?.startedAt ?? input.now;

  const result = await sql.begin(async (tx) => {
    const [limit] = await tx<{ credit_limit_cents: number | null }[]>`
      SELECT credit_limit_cents FROM fleets WHERE id = ${demo.fleetId} FOR UPDATE
    `;
    const exposure = await loadFleetCreditExposure(tx, demo.fleetId);
    const existing = await tx<{ id: string }[]>`
      SELECT id FROM charging_sessions WHERE id = ANY(${candidates.map((c) => c.id)}::text[])
    `;
    const busyRows = await tx<
      { evse_id: string | null; started_at: Date | string | null; ended_at: Date | string | null }[]
    >`
      SELECT evse_id, started_at, coalesce(ended_at, now()) AS ended_at FROM charging_sessions
      WHERE station_id = ${stationId} AND started_at IS NOT NULL
        AND started_at < ${input.now.toISOString()}::timestamptz
        AND coalesce(ended_at, now()) > ${windowStart.toISOString()}::timestamptz
    `;
    const busy: FleetHistoryBusy[] = busyRows.map((r) => ({
      evseId: r.evse_id,
      startedAt: new Date(r.started_at ?? 0),
      endedAt: new Date(r.ended_at ?? 0),
    }));
    const selection = selectFleetHistory({
      candidates,
      existingIds: new Set(existing.map((r) => r.id)),
      evseIds: evses.length > 0 ? evses.map((e) => e.id) : [null],
      busy,
      budgetCents: fleetHistoryBudget(limit?.credit_limit_cents ?? null, exposure.totalCents),
    });
    let inserted = 0;
    for (const session of selection.sessions) {
      const payer = payers.get(session.payer) ?? fallback[0];
      inserted += await insertDemoAccountSession(tx, {
        id: session.id,
        transactionId: session.transactionId,
        startedAt: session.startedAt,
        endedAt: session.endedAt,
        energyWh: session.energyWh,
        costCents: session.costCents,
        invoiceId: null,
        stationId,
        evseId: session.evseId,
        driverId: payer?.driverId ?? null,
        tokenId: payer?.tokenId ?? null,
        fleetId: demo.fleetId,
        memberBilled: false,
        taxRate: TAX_RATE,
        currency: input.currency,
        electricityCostCents: place.electricityCostOf(session.endedAt, session.energyWh),
      });
    }
    return { inserted, skippedBusy: selection.skippedBusy, skippedBudget: selection.skippedBudget };
  });
  return {
    sessions: result.inserted,
    skippedBusy: result.skippedBusy,
    skippedBudget: result.skippedBudget,
    creditLimitRaised,
  };
}

// ---------- Shared by the fleet billing and member invoice demos ----------

/** Where the demo sessions ran: the printed station name and the site's electricity cost. */
export interface DemoStationPlace {
  stationName: string;
  electricityCostOf(endedAt: Date, energyWh: number): number | null;
}

/** Reads the demo station's name and its site's electricity rate periods. */
export async function loadDemoStationPlace(
  sql: postgres.Sql,
  stationId: string,
): Promise<DemoStationPlace> {
  const [place] = await sql<
    Array<{
      station_id: string;
      site_id: string | null;
      site_name: string | null;
      timezone: string | null;
    }>
  >`
    SELECT st.station_id, st.site_id, si.name AS site_name, si.timezone
    FROM charging_stations st LEFT JOIN sites si ON si.id = st.site_id
    WHERE st.id = ${stationId}
  `;
  // The sessions' electricity cost from the station's site rates, as the
  // session end projection computes it (computeSessionElectricityCost).
  const ratePeriods =
    place?.site_id != null ? await loadElectricityRatePeriodsForSite(place.site_id) : [];
  return {
    stationName:
      place == null
        ? ''
        : place.site_name != null && place.site_name !== ''
          ? `${place.site_name} ${place.station_id}`
          : place.station_id,
    electricityCostOf: (endedAt, energyWh) =>
      computeSessionElectricityCost({
        periods: ratePeriods,
        endedAt,
        energyWh,
        timezone: place?.timezone,
      }).costCents,
  };
}

/** A billed session as an invoice line prints it. */
export interface DemoLineSession {
  id: string;
  endedAt: Date;
  energyWh: number;
  costCents: number;
  driverId: string;
  driverName: string;
}

export interface DemoInvoiceValues {
  kind: 'invoice' | 'credit_note';
  status: 'issued' | 'credited';
  issuedAt: Date;
  period: { start: string; end: string };
  sessions: DemoLineSession[];
  taxRate: number;
  sign: 1 | -1;
  creditedInvoiceId: string | null;
  creditReason: string | null;
  fleetId: string;
  /** Null on a fleet invoice, the member on a member invoice. */
  driverId: string | null;
  memberBilled: boolean;
  billTo: Record<string, string | null>;
  language: string;
  currency: string;
  paymentTermsDays: number;
}

function sessionTaxLines(costCents: number, taxRate: number): TaxLine[] {
  return chargedCostBreakdown(costCents, taxRate, DEFAULT_TAX_BASIS).taxLines;
}

/**
 * Inserts a demo account invoice or credit note when its id does not exist
 * yet. The number comes from the gap-free counter in the same transaction as
 * the insert, so a rerun allocates nothing and a concurrent seed that wins
 * the insert gives the number back.
 */
export async function insertDemoInvoice(
  sql: postgres.Sql,
  id: string,
  values: DemoInvoiceValues,
): Promise<void> {
  const [existing] = await sql`SELECT 1 FROM invoices WHERE id = ${id}`;
  if (existing != null) return;
  const totals = taxTotals(
    values.sessions.flatMap((session) => sessionTaxLines(session.costCents, values.taxRate)),
  );
  const sign = values.sign;
  const dueAt =
    values.kind === 'invoice'
      ? new Date(values.issuedAt.getTime() + values.paymentTermsDays * DAY_MS).toISOString()
      : null;
  const sentAt = new Date(values.issuedAt.getTime() + 5 * 60_000).toISOString();
  const issuedAt = values.issuedAt.toISOString();
  try {
    await db.transaction(async (tx) => {
      const number = await allocateInvoiceNumber(tx, values.kind, values.issuedAt);
      const rows = await tx.execute(dsql`
        INSERT INTO invoices (id, invoice_number, status, kind, credited_invoice_id,
          credit_reason, issued_at, due_at, currency, subtotal_cents, tax_cents, total_cents,
          fleet_id, period_start, period_end, bill_to, language, sent_at, created_at, updated_at,
          driver_id, member_billed)
        VALUES (${id}, ${number}, ${values.status}, ${values.kind},
          ${values.creditedInvoiceId}, ${values.creditReason}, ${issuedAt}::timestamptz,
          ${dueAt}::timestamptz, ${values.currency}, ${signed(totals.netCents, sign)},
          ${signed(totals.taxCents, sign)}, ${signed(totals.grossCents, sign)}, ${values.fleetId},
          ${values.period.start}::date, ${values.period.end}::date,
          ${JSON.stringify(values.billTo)}::jsonb, ${values.language}, ${sentAt}::timestamptz,
          ${issuedAt}::timestamptz, ${issuedAt}::timestamptz, ${values.driverId},
          ${values.memberBilled})
        ON CONFLICT (id) DO NOTHING
        RETURNING id
      `);
      if (rows.length === 0) throw new DemoInvoiceExists();
    });
  } catch (err) {
    // A concurrent seed inserted this invoice; the rollback gave its number back.
    if (!(err instanceof DemoInvoiceExists)) throw err;
  }
}

/** A completed account session of a demo fleet. */
export interface DemoAccountSession {
  id: string;
  transactionId: string;
  startedAt: Date;
  endedAt: Date;
  energyWh: number;
  costCents: number;
  invoiceId: string | null;
  stationId: string;
  evseId: string | null;
  driverId: string | null;
  /** The fleet RFID card the session started with; null for an app or portal start. */
  tokenId?: string | null;
  fleetId: string;
  memberBilled: boolean;
  taxRate: number;
  currency: string;
  electricityCostCents: number | null;
}

/** Inserts a demo account session when missing. Returns 1 when inserted, else 0. */
export async function insertDemoAccountSession(
  sql: postgres.Sql | postgres.TransactionSql,
  session: DemoAccountSession,
): Promise<number> {
  const breakdown = chargedCostBreakdown(session.costCents, session.taxRate, DEFAULT_TAX_BASIS);
  const rows = await sql`
    INSERT INTO charging_sessions (id, station_id, site_id, evse_id, driver_id, token_id, transaction_id, status,
      started_at, ended_at, meter_start, meter_stop, energy_delivered_wh, final_cost_cents,
      tariff_tax_rate, net_cents, tax_cents, cost_breakdown, currency, stopped_reason,
      billing_mode, billing_fleet_id, invoice_id, electricity_cost_cents, created_at, updated_at,
      member_billed)
    VALUES (${session.id}, ${session.stationId}, ${sessionSiteIdSql(sql, session.stationId)}, ${session.evseId}, ${session.driverId},
      ${session.tokenId ?? null}, ${session.transactionId}, 'completed', ${session.startedAt}, ${session.endedAt}, 0,
      ${session.energyWh}, ${String(session.energyWh)}, ${session.costCents},
      ${String(session.taxRate)}, ${breakdown.netCents}, ${breakdown.taxCents},
      ${sql.json(breakdown as unknown as postgres.JSONValue)}, ${session.currency},
      'EVDisconnected', 'account', ${session.fleetId}, ${session.invoiceId},
      ${session.electricityCostCents}, ${session.startedAt}, ${session.endedAt},
      ${session.memberBilled})
    ON CONFLICT DO NOTHING
    RETURNING id
  `;
  return rows.length;
}

/**
 * Inserts the line items of a demo invoice, one 'session' line per tax line in
 * the given session order, only with the invoice's first seed (line items have
 * a serial id, so a rerun must not add them again).
 */
export async function insertDemoLineItems(
  sql: postgres.Sql,
  invoiceId: string,
  sessions: DemoLineSession[],
  sign: 1 | -1,
  options: { stationName: string; taxRate: number },
): Promise<void> {
  const [existing] =
    await sql`SELECT 1 FROM invoice_line_items WHERE invoice_id = ${invoiceId} LIMIT 1`;
  if (existing != null) return;
  const { stationName } = options;
  for (const session of sessions) {
    const sessionDate = session.endedAt.toISOString().slice(0, 10);
    const description = `Charging session ${sessionDate}, ${stationName}, ${session.driverName} (${(session.energyWh / 1000).toFixed(2)} kWh)`;
    const metadata = {
      kind: 'session',
      sessionDate,
      energyWh: session.energyWh,
      driverId: session.driverId,
      driverName: session.driverName,
      stationName,
    };
    for (const line of sessionTaxLines(session.costCents, options.taxRate)) {
      await sql`
        INSERT INTO invoice_line_items (invoice_id, session_id, description, quantity,
          unit_price_cents, total_cents, tax_cents, tax_rate, metadata)
        VALUES (${invoiceId}, ${session.id}, ${description}, ${'1'},
          ${signed(line.netCents, sign)}, ${signed(line.netCents, sign)},
          ${signed(line.taxCents, sign)}, ${String(line.taxRate)}, ${sql.json(metadata)})
      `;
    }
  }
}
