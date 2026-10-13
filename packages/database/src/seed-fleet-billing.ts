// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import type postgres from 'postgres';
import argon2 from 'argon2';
import { sql as dsql } from 'drizzle-orm';
import {
  DEFAULT_TAX_BASIS,
  chargedCostBreakdown,
  computeSessionElectricityCost,
  taxTotals,
} from '@evtivity/lib';
import type { TaxLine } from '@evtivity/lib';
import { db } from './config.js';
import { loadElectricityRatePeriodsForSite } from './lib/electricity-rate.js';
import { allocateInvoiceNumber } from './lib/invoice-number.js';

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
} as const;

const FLEET_NAME = 'Northwind Logistics';
const TAX_RATE = 0.08;
const CREDIT_LIMIT_CENTS = 50_000;
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
  driverId: string;
  fleetId: string;
  memberBilled: boolean;
  taxRate: number;
  currency: string;
  electricityCostCents: number | null;
}

/** Inserts a demo account session when missing. Returns 1 when inserted, else 0. */
export async function insertDemoAccountSession(
  sql: postgres.Sql,
  session: DemoAccountSession,
): Promise<number> {
  const breakdown = chargedCostBreakdown(session.costCents, session.taxRate, DEFAULT_TAX_BASIS);
  const rows = await sql`
    INSERT INTO charging_sessions (id, station_id, evse_id, driver_id, transaction_id, status,
      started_at, ended_at, meter_start, meter_stop, energy_delivered_wh, final_cost_cents,
      tariff_tax_rate, net_cents, tax_cents, cost_breakdown, currency, stopped_reason,
      billing_mode, billing_fleet_id, invoice_id, electricity_cost_cents, created_at, updated_at,
      member_billed)
    VALUES (${session.id}, ${session.stationId}, ${session.evseId}, ${session.driverId},
      ${session.transactionId}, 'completed', ${session.startedAt}, ${session.endedAt}, 0,
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
