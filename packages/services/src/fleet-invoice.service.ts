// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { sql } from 'drizzle-orm';
import {
  db,
  chargingSessions,
  getCompanyCurrency,
  getSystemTimezone,
  pgConstraintName,
  pgErrorCode,
  PG_UNIQUE_VIOLATION,
} from '@evtivity/database';
import { AppError, dimensionAmounts, isValidTimezone, taxTotals } from '@evtivity/lib';
import {
  insertInvoiceInTransaction,
  sessionCostBreakdown,
  sessionSummaryLines,
  type InvoiceTx,
  type InvoiceWithLineItems,
  type LineDraft,
  type SessionForInvoice,
} from './invoice.service.js';
import { isInvoiceLanguage } from './invoice-labels.js';

/** A billing period: a calendar month, `YYYY-MM`. */
export const FLEET_INVOICE_PERIOD_PATTERN = /^\d{4}-(0[1-9]|1[0-2])$/;

/** The unique index of one live invoice per fleet and period. */
const FLEET_PERIOD_INDEX = 'uq_invoices_fleet_period';

/** Excluded sessions the preview lists at most. */
export const FLEET_INVOICE_EXCLUDED_LIMIT = 100;

/** A calendar month in the system timezone. */
export interface FleetInvoicePeriod {
  /** `YYYY-MM`. */
  period: string;
  /** First day (`YYYY-MM-DD`). */
  periodStart: string;
  /** Last day (`YYYY-MM-DD`). */
  periodEnd: string;
  /** Midnight of the first day in the system timezone. */
  startsAt: Date;
  /** Midnight of the first day of the next month: sessions ended before it are billed. */
  endsAt: Date;
}

/** Wall-clock offset of a timezone at an instant, in milliseconds (local minus UTC). */
function zoneOffsetMs(at: Date, timeZone: string): number {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone,
    hourCycle: 'h23',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  }).formatToParts(at);
  const value = (type: string): number => Number(parts.find((p) => p.type === type)?.value ?? 0);
  const local = Date.UTC(
    value('year'),
    value('month') - 1,
    value('day'),
    value('hour'),
    value('minute'),
    value('second'),
  );
  return local - (at.getTime() - at.getUTCMilliseconds());
}

/**
 * The instant of midnight at the start of a day in a timezone. Two passes, so
 * a day that starts at a DST change resolves to the offset in force then.
 */
export function zonedMidnight(year: number, month: number, day: number, timeZone: string): Date {
  const guess = Date.UTC(year, month - 1, day);
  const first = guess - zoneOffsetMs(new Date(guess), timeZone);
  const second = guess - zoneOffsetMs(new Date(first), timeZone);
  return new Date(second);
}

function pad2(n: number): string {
  return String(n).padStart(2, '0');
}

/** The timezone to compute periods in: the system timezone, UTC when it is invalid. */
function periodZone(timeZone: string): string {
  return isValidTimezone(timeZone) ? timeZone : 'UTC';
}

/**
 * The bounds of a `YYYY-MM` period in a timezone. Throws VALIDATION_ERROR
 * (400) for a malformed period.
 */
export function fleetInvoicePeriod(period: string, timeZone: string): FleetInvoicePeriod {
  if (!FLEET_INVOICE_PERIOD_PATTERN.test(period)) {
    throw new AppError('period must be a calendar month (YYYY-MM)', 400, 'VALIDATION_ERROR');
  }
  const zone = periodZone(timeZone);
  const year = Number(period.slice(0, 4));
  const month = Number(period.slice(5, 7));
  const nextYear = month === 12 ? year + 1 : year;
  const nextMonth = month === 12 ? 1 : month + 1;
  const lastDay = new Date(Date.UTC(year, month, 0)).getUTCDate();
  return {
    period,
    periodStart: `${String(year)}-${pad2(month)}-01`,
    periodEnd: `${String(year)}-${pad2(month)}-${pad2(lastDay)}`,
    startsAt: zonedMidnight(year, month, 1, zone),
    endsAt: zonedMidnight(nextYear, nextMonth, 1, zone),
  };
}

/** The calendar month (`YYYY-MM`) of an instant in a timezone. */
export function periodOf(at: Date, timeZone: string): string {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: periodZone(timeZone),
    year: 'numeric',
    month: '2-digit',
  }).formatToParts(at);
  const year = parts.find((p) => p.type === 'year')?.value ?? String(at.getUTCFullYear());
  const month = parts.find((p) => p.type === 'month')?.value ?? pad2(at.getUTCMonth() + 1);
  return `${year}-${month}`;
}

/** The month before the current one in a timezone: the default period to bill. */
export function previousPeriod(now: Date, timeZone: string): string {
  const current = periodOf(now, timeZone);
  const year = Number(current.slice(0, 4));
  const month = Number(current.slice(5, 7));
  return month === 1 ? `${String(year - 1)}-12` : `${String(year)}-${pad2(month - 1)}`;
}

/** The calendar date (`YYYY-MM-DD`) of an instant in a timezone. */
export function dateIn(at: Date, timeZone: string): string {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: periodZone(timeZone),
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(at);
  const value = (type: string): string => parts.find((p) => p.type === type)?.value ?? '';
  return `${value('year')}-${value('month')}-${value('day')}`;
}

/** The fleet billing profile's bill-to block, snapshotted onto the invoice (GoBD). */
export interface FleetBillTo {
  /** The legal name, else the fleet name. */
  name: string;
  street: string | null;
  city: string | null;
  state: string | null;
  zip: string | null;
  country: string | null;
  taxId: string | null;
}

/** The fleet fields a fleet invoice reads. */
export interface FleetForInvoice {
  id: string;
  name: string;
  billingLegalName: string | null;
  billingStreet: string | null;
  billingCity: string | null;
  billingState: string | null;
  billingZip: string | null;
  billingCountry: string | null;
  billingTaxId: string | null;
  invoiceLanguage: string;
  paymentTermsDays: number | null;
}

export function billToFromFleet(fleet: FleetForInvoice): FleetBillTo {
  const legal = fleet.billingLegalName?.trim() ?? '';
  return {
    name: legal !== '' ? legal : fleet.name,
    street: fleet.billingStreet,
    city: fleet.billingCity,
    state: fleet.billingState,
    zip: fleet.billingZip,
    country: fleet.billingCountry,
    taxId: fleet.billingTaxId,
  };
}

/** An ended account session of the fleet that no invoice billed yet. */
export interface FleetSessionCandidate {
  id: string;
  driverId: string | null;
  driverName: string;
  stationName: string;
  siteName: string | null;
  endedAt: Date | null;
  energyDeliveredWh: string | null;
  finalCostCents: number | null;
  currency: string;
  tariffTaxRate: string | null;
  costBreakdown: unknown;
}

/** Why an unbilled account session is left off the fleet invoice. */
export type FleetInvoiceExclusion = 'other_currency' | 'zero_cost' | 'uncosted';

export interface FleetInvoiceExcludedSession {
  sessionId: string;
  driverId: string | null;
  driverName: string;
  endedAt: Date | null;
  reason: FleetInvoiceExclusion;
  currency: string;
  finalCostCents: number | null;
}

/** One driver's sessions on the fleet invoice. */
export interface FleetInvoiceDriverTotal {
  driverId: string | null;
  driverName: string;
  sessionCount: number;
  energyWh: number;
  netCents: number;
  taxCents: number;
  totalCents: number;
}

export interface FleetInvoicePlan {
  /** Sessions the invoice bills, grouped by driver, each driver's by end time. */
  sessions: FleetSessionCandidate[];
  /** Line items in the same order, carrying the driver of each session. */
  lines: LineDraft[];
  drivers: FleetInvoiceDriverTotal[];
  excluded: FleetInvoiceExcludedSession[];
  netCents: number;
  taxCents: number;
  totalCents: number;
  energyWh: number;
}

/** Driver grouping key: the driver id, or '' for a session whose driver was deleted. */
function driverKey(driverId: string | null): string {
  return driverId ?? '';
}

function compareDrivers(
  a: { driverName: string; driverId: string | null },
  b: { driverName: string; driverId: string | null },
): number {
  const byName = a.driverName.localeCompare(b.driverName);
  if (byName !== 0) return byName;
  return driverKey(a.driverId).localeCompare(driverKey(b.driverId));
}

function exclusionOf(
  session: FleetSessionCandidate,
  currency: string,
): FleetInvoiceExclusion | null {
  if (session.currency.toUpperCase() !== currency.toUpperCase()) return 'other_currency';
  if (session.finalCostCents == null) return 'uncosted';
  if (session.finalCostCents <= 0) return 'zero_cost';
  return null;
}

/**
 * The lines of a fleet invoice from its candidate sessions (pure). A session
 * in another currency than the company currency, without a final cost, or
 * with a cost of zero is left off and listed in `excluded`. Each billed
 * session gets one 'session' line per tax rate of its stored breakdown (the
 * tax snapshot of the session, as on an aggregated driver invoice), carrying
 * the driver, the station and the session date in the system timezone, so the
 * PDF groups the lines by driver with subtotals.
 */
export function planFleetInvoice(
  candidates: FleetSessionCandidate[],
  currency: string,
  timeZone: string,
): FleetInvoicePlan {
  const excluded: FleetInvoiceExcludedSession[] = [];
  const billable: FleetSessionCandidate[] = [];
  for (const session of candidates) {
    const reason = exclusionOf(session, currency);
    if (reason == null) {
      billable.push(session);
    } else {
      excluded.push({
        sessionId: session.id,
        driverId: session.driverId,
        driverName: session.driverName,
        endedAt: session.endedAt,
        reason,
        currency: session.currency.toUpperCase(),
        finalCostCents: session.finalCostCents,
      });
    }
  }

  billable.sort((a, b) => {
    const byDriver = compareDrivers(a, b);
    if (byDriver !== 0) return byDriver;
    const byEnd = (a.endedAt?.getTime() ?? 0) - (b.endedAt?.getTime() ?? 0);
    return byEnd !== 0 ? byEnd : a.id.localeCompare(b.id);
  });

  const lines: LineDraft[] = [];
  const totals = new Map<string, FleetInvoiceDriverTotal>();
  let energyWh = 0;
  for (const session of billable) {
    const forInvoice: SessionForInvoice = {
      id: session.id,
      invoiceId: null,
      driverId: session.driverId,
      energyDeliveredWh: session.energyDeliveredWh,
      endedAt: session.endedAt,
      finalCostCents: session.finalCostCents ?? 0,
      tariffTaxRate: session.tariffTaxRate,
      costBreakdown: session.costBreakdown,
    };
    const sessionEnergy = session.energyDeliveredWh != null ? Number(session.energyDeliveredWh) : 0;
    const sessionDate = session.endedAt != null ? dateIn(session.endedAt, timeZone) : 'unknown';
    const place =
      session.siteName != null && session.siteName !== ''
        ? `${session.siteName} ${session.stationName}`
        : session.stationName;
    const description = `Charging session ${sessionDate}, ${place}, ${session.driverName} (${(sessionEnergy / 1000).toFixed(2)} kWh)`;
    const sessionLines = fleetSessionLines(forInvoice).map(
      (line): LineDraft => ({
        ...line,
        description:
          line.metadata.kind === 'idleFee' ? line.description : description.slice(0, 500),
        metadata: {
          ...line.metadata,
          sessionDate,
          energyWh: sessionEnergy,
          ...(session.driverId != null ? { driverId: session.driverId } : {}),
          driverName: session.driverName,
          stationName: place,
        },
      }),
    );
    lines.push(...sessionLines);
    energyWh += sessionEnergy;

    const key = driverKey(session.driverId);
    const sums = taxTotals(sessionLines);
    const current = totals.get(key) ?? {
      driverId: session.driverId,
      driverName: session.driverName,
      sessionCount: 0,
      energyWh: 0,
      netCents: 0,
      taxCents: 0,
      totalCents: 0,
    };
    current.sessionCount += 1;
    current.energyWh += sessionEnergy;
    current.netCents += sums.netCents;
    current.taxCents += sums.taxCents;
    current.totalCents += sums.grossCents;
    totals.set(key, current);
  }

  const all = taxTotals(lines);
  return {
    sessions: billable,
    lines,
    drivers: [...totals.values()].sort(compareDrivers),
    excluded,
    netCents: all.netCents,
    taxCents: all.taxCents,
    totalCents: all.grossCents,
    energyWh,
  };
}

type Executor = Pick<typeof db, 'execute'>;

function fleetNotFound(): AppError {
  return new AppError('Fleet not found', 404, 'FLEET_NOT_FOUND');
}

/**
 * The fleet's billing profile. `lock` takes the fleet row (`FOR UPDATE`) in
 * the caller's transaction: generations of one fleet then run one after the
 * other, and the profile cannot change while the invoice snapshots it.
 */
async function loadFleet(
  executor: Executor,
  fleetId: string,
  lock = false,
): Promise<FleetForInvoice | null> {
  const rows = (await executor.execute(sql`
    SELECT id, name, billing_legal_name, billing_street, billing_city, billing_state,
           billing_zip, billing_country, billing_tax_id, invoice_language, payment_terms_days
    FROM fleets WHERE id = ${fleetId}
    ${lock ? sql`FOR UPDATE` : sql``}
  `)) as unknown as Array<Record<string, unknown>>;
  const row = rows[0];
  if (row == null) return null;
  const text = (key: string): string | null => {
    const value = row[key];
    return typeof value === 'string' ? value : null;
  };
  return {
    id: String(row['id']),
    name: String(row['name']),
    billingLegalName: text('billing_legal_name'),
    billingStreet: text('billing_street'),
    billingCity: text('billing_city'),
    billingState: text('billing_state'),
    billingZip: text('billing_zip'),
    billingCountry: text('billing_country'),
    billingTaxId: text('billing_tax_id'),
    invoiceLanguage: text('invoice_language') ?? 'en',
    paymentTermsDays: row['payment_terms_days'] == null ? null : Number(row['payment_terms_days']),
  };
}

/**
 * The fleet's ended account sessions that no invoice billed, ended before
 * `endsAt` (sessions of earlier months that are still unbilled, such as ones
 * a credit note released, are billed too; sessions that end later roll into
 * the next invoice). Billed on account means: stamped `account` for the fleet,
 * no payment record (one with a record was paid by card), completed, and no
 * invoice_id. `lock` takes the selected session rows (`FOR UPDATE OF cs`)
 * in the caller's transaction, so nothing can bill or change them before the
 * invoice claims them. With `startsAt` (the scheduled run), only sessions
 * ended in the month itself: earlier months get their own invoice.
 */
export async function loadFleetInvoiceCandidates(
  executor: Executor,
  fleetId: string,
  endsAt: Date,
  options: { lock?: boolean; startsAt?: Date } = {},
): Promise<FleetSessionCandidate[]> {
  const lowerBound =
    options.startsAt == null
      ? sql``
      : sql`AND cs.ended_at >= ${options.startsAt.toISOString()}::timestamptz`;
  const rows = (await executor.execute(sql`
    SELECT cs.id, cs.driver_id, d.first_name, d.last_name, st.station_id AS station_name,
           si.name AS site_name, cs.ended_at, cs.energy_delivered_wh, cs.final_cost_cents,
           upper(cs.currency) AS currency, cs.tariff_tax_rate, cs.cost_breakdown
    FROM charging_sessions cs
    LEFT JOIN drivers d ON d.id = cs.driver_id
    LEFT JOIN charging_stations st ON st.id = cs.station_id
    LEFT JOIN sites si ON si.id = st.site_id
    WHERE cs.billing_fleet_id = ${fleetId}
      AND cs.billing_mode = 'account'
      AND cs.status = 'completed'
      AND cs.invoice_id IS NULL
      AND cs.ended_at < ${endsAt.toISOString()}::timestamptz
      ${lowerBound}
      AND NOT EXISTS (SELECT 1 FROM payment_records pr WHERE pr.session_id = cs.id)
    ORDER BY cs.ended_at, cs.id
    ${options.lock === true ? sql`FOR UPDATE OF cs` : sql``}
  `)) as unknown as Array<Record<string, unknown>>;
  return rows.map((row) => {
    const first = typeof row['first_name'] === 'string' ? row['first_name'] : '';
    const last = typeof row['last_name'] === 'string' ? row['last_name'] : '';
    const ended = row['ended_at'];
    return {
      id: String(row['id']),
      driverId: typeof row['driver_id'] === 'string' ? row['driver_id'] : null,
      driverName: `${first} ${last}`.trim(),
      stationName: typeof row['station_name'] === 'string' ? row['station_name'] : '',
      siteName: typeof row['site_name'] === 'string' ? row['site_name'] : null,
      endedAt: ended == null ? null : new Date(ended as string | Date),
      energyDeliveredWh: numericText(row['energy_delivered_wh']),
      finalCostCents: row['final_cost_cents'] == null ? null : Number(row['final_cost_cents']),
      currency: typeof row['currency'] === 'string' ? row['currency'] : '',
      tariffTaxRate: numericText(row['tariff_tax_rate']),
      costBreakdown: row['cost_breakdown'] ?? null,
    };
  });
}

/** A numeric column as postgres.js returns it (a string), or null. */
function numericText(value: unknown): string | null {
  if (typeof value === 'string') return value;
  if (typeof value === 'number') return String(value);
  return null;
}

/** The live invoice of a fleet and period (not void, not credited), if any. */
export interface FleetPeriodInvoice {
  id: string;
  invoiceNumber: string;
  status: string;
}

export async function findPeriodInvoice(
  executor: Executor,
  fleetId: string,
  periodStart: string,
): Promise<FleetPeriodInvoice | null> {
  const rows = (await executor.execute(sql`
    SELECT id, invoice_number, status FROM invoices
    WHERE fleet_id = ${fleetId} AND period_start = ${periodStart}::date
      AND kind = 'invoice' AND status NOT IN ('void', 'credited')
    LIMIT 1
  `)) as unknown as Array<Record<string, unknown>>;
  const row = rows[0];
  if (row == null) return null;
  return {
    id: String(row['id']),
    invoiceNumber: String(row['invoice_number']),
    status: String(row['status']),
  };
}

function periodExistsError(existing: FleetPeriodInvoice): AppError {
  return new AppError(
    `The fleet already has invoice ${existing.invoiceNumber} for this period; credit it to bill the period again`,
    409,
    'FLEET_INVOICE_PERIOD_EXISTS',
  );
}

/** Refuses a period that has not started yet in the system timezone. */
function assertPeriodStarted(bounds: FleetInvoicePeriod, now: Date): void {
  if (bounds.startsAt.getTime() > now.getTime()) {
    throw new AppError('period must not be in the future', 400, 'VALIDATION_ERROR');
  }
}

/** What the fleet invoice of a period would bill (GET preview). */
export interface FleetInvoicePreview {
  fleetId: string;
  period: string;
  periodStart: string;
  periodEnd: string;
  currency: string;
  sessionCount: number;
  energyWh: number;
  netCents: number;
  taxCents: number;
  totalCents: number;
  drivers: FleetInvoiceDriverTotal[];
  /** Unbilled account sessions left off (other currency, no cost, zero cost), at most FLEET_INVOICE_EXCLUDED_LIMIT. */
  excluded: FleetInvoiceExcludedSession[];
  excludedCount: number;
  /** The fleet's live invoice of the period; generating again is refused while it exists. */
  existingInvoice: FleetPeriodInvoice | null;
}

/**
 * The unbilled account sessions of a fleet the invoice of `period` would bill,
 * per driver, and the ones it would leave off. Reads only. Throws
 * FLEET_NOT_FOUND (404) and VALIDATION_ERROR (400) for a malformed period.
 */
export async function previewFleetInvoice(
  fleetId: string,
  period: string,
): Promise<FleetInvoicePreview> {
  const timeZone = await getSystemTimezone();
  const bounds = fleetInvoicePeriod(period, timeZone);
  const fleet = await loadFleet(db, fleetId);
  if (fleet == null) throw fleetNotFound();
  const currency = await getCompanyCurrency();
  const [candidates, existingInvoice] = await Promise.all([
    loadFleetInvoiceCandidates(db, fleetId, bounds.endsAt),
    findPeriodInvoice(db, fleetId, bounds.periodStart),
  ]);
  const plan = planFleetInvoice(candidates, currency, timeZone);
  return {
    fleetId,
    period: bounds.period,
    periodStart: bounds.periodStart,
    periodEnd: bounds.periodEnd,
    currency,
    sessionCount: plan.sessions.length,
    energyWh: plan.energyWh,
    netCents: plan.netCents,
    taxCents: plan.taxCents,
    totalCents: plan.totalCents,
    drivers: plan.drivers,
    excluded: plan.excluded.slice(0, FLEET_INVOICE_EXCLUDED_LIMIT),
    excludedCount: plan.excluded.length,
    existingInvoice,
  };
}

/**
 * The lines of one session on a fleet invoice (owner decision 2026-10-08):
 * per tax rate, a 'session' line with the session's amount without its idle
 * fee, then an 'idleFee' line with the idle fee and the idle minutes billed,
 * both from the stored cost breakdown. The lines of a rate add up to the
 * breakdown's tax line of that rate, so totals and tax are unchanged. A
 * breakdown without components (no itemized cost) gives the session lines only.
 */
export function fleetSessionLines(session: SessionForInvoice): LineDraft[] {
  const breakdown = sessionCostBreakdown(session);
  const summary = sessionSummaryLines(session, breakdown.taxLines);
  const idleByRate = new Map<
    number,
    { netCents: number; taxCents: number; minutes: number; minutesKnown: boolean }
  >();
  for (const group of breakdown.components ?? []) {
    for (const line of group.taxLines) {
      if (line.idleFeeCents === 0) continue;
      const amount = dimensionAmounts(line, breakdown.basis).idleFeeCents;
      const current = idleByRate.get(line.taxRate) ?? {
        netCents: 0,
        taxCents: 0,
        minutes: 0,
        minutesKnown: true,
      };
      current.netCents += amount.netCents;
      current.taxCents += amount.taxCents;
      if (group.billableIdleMinutes != null) current.minutes += group.billableIdleMinutes;
      else current.minutesKnown = false;
      idleByRate.set(line.taxRate, current);
    }
  }
  if (idleByRate.size === 0) return summary;

  const lines: LineDraft[] = [];
  for (const line of summary) {
    const idle = idleByRate.get(line.taxRate);
    if (idle == null) {
      lines.push(line);
      continue;
    }
    const rest = {
      ...line,
      netCents: line.netCents - idle.netCents,
      taxCents: line.taxCents - idle.taxCents,
    };
    // A rate billed only for idle keeps no empty session line.
    if (rest.netCents !== 0 || rest.taxCents !== 0) lines.push(rest);
    const minutes = idle.minutesKnown ? Math.round(idle.minutes) : null;
    lines.push({
      sessionId: line.sessionId,
      description: minutes != null ? `Idle fee, ${String(minutes)} min` : 'Idle fee',
      metadata: { kind: 'idleFee', ...(minutes != null ? { idleMinutes: minutes } : {}) },
      taxRate: line.taxRate,
      netCents: idle.netCents,
      taxCents: idle.taxCents,
    });
  }
  // Every session keeps a session line, so it reads as one charging session.
  if (!lines.some((l) => l.metadata.kind === 'session')) {
    const first = summary[0];
    if (first != null) lines.unshift({ ...first, netCents: 0, taxCents: 0 });
  }
  return lines;
}

export interface FleetInvoiceResult extends InvoiceWithLineItems {
  drivers: FleetInvoiceDriverTotal[];
  /** Unbilled account sessions left off, at most FLEET_INVOICE_EXCLUDED_LIMIT. */
  excluded: FleetInvoiceExcludedSession[];
  excludedCount: number;
}

/**
 * Issues the fleet invoice of a calendar month (system timezone): every
 * account session of the fleet that no invoice billed, ended before the end of
 * the month, in the company currency and with a cost, itemized by driver with
 * the tax snapshot of each session. Issued directly (status 'issued', never a
 * draft), numbered from the invoice counter, due after the fleet's payment
 * terms (else the invoice.paymentTermsDays setting), with the bill-to block
 * and language of the fleet billing profile at issue.
 *
 * One transaction, all or nothing: it locks the fleet row (generations of one
 * fleet run one after the other) and reads the billing profile under it,
 * refuses a period that already has a live invoice
 * (FLEET_INVOICE_PERIOD_EXISTS, 409; the unique index uq_invoices_fleet_period
 * refuses it at the database too), then reads and locks the sessions to bill
 * (`FOR UPDATE OF cs`) and builds the lines from that read, so a concurrent
 * generation that billed some of them meanwhile leaves only the rest. The
 * invoice number is allocated only after that read, when the claim of the
 * locked sessions cannot fail, so a refused generation never consumes a
 * number. The claim
 * keeps its guard (invoice_id set only while null and only for sessions still
 * billed on account to the fleet) as the second layer.
 *
 * Throws FLEET_NOT_FOUND (404), VALIDATION_ERROR (400) for a malformed or
 * future period, FLEET_INVOICE_NOTHING_TO_BILL (409) when nothing is left to
 * bill after the locked read, and INVOICE_CREATION_FAILED (400) when the
 * claim still finds a session billed meanwhile.
 *
 * `periodOnly` (the scheduled run) bills only sessions ended in the month, so
 * each month's sessions stay on that month's invoice.
 */
export async function createFleetInvoice(
  fleetId: string,
  period: string,
  now: Date = new Date(),
  options: { periodOnly?: boolean } = {},
): Promise<FleetInvoiceResult> {
  const timeZone = await getSystemTimezone();
  const bounds = fleetInvoicePeriod(period, timeZone);
  assertPeriodStarted(bounds, now);
  // Fast refusals before the transaction; both are checked again under the lock.
  if ((await loadFleet(db, fleetId)) == null) throw fleetNotFound();
  const existing = await findPeriodInvoice(db, fleetId, bounds.periodStart);
  if (existing != null) throw periodExistsError(existing);

  const currency = await getCompanyCurrency();
  const sessionClaimGuard = sql`${chargingSessions.billingMode} = 'account'
    AND ${chargingSessions.billingFleetId} = ${fleetId}
    AND NOT EXISTS (SELECT 1 FROM payment_records fpr WHERE fpr.session_id = ${chargingSessions.id})`;

  try {
    return await db.transaction(async (tx: InvoiceTx) => {
      // Generations of one fleet run one after the other; the second sees the
      // first's invoice and claimed sessions.
      const fleet = await loadFleet(tx, fleetId, true);
      if (fleet == null) throw fleetNotFound();
      const live = await findPeriodInvoice(tx, fleetId, bounds.periodStart);
      if (live != null) throw periodExistsError(live);

      const candidates = await loadFleetInvoiceCandidates(tx, fleetId, bounds.endsAt, {
        lock: true,
        ...(options.periodOnly === true ? { startsAt: bounds.startsAt } : {}),
      });
      const plan = planFleetInvoice(candidates, currency, timeZone);
      if (plan.sessions.length === 0) {
        throw new AppError(
          'The fleet has no unbilled account session with a cost in this period',
          409,
          'FLEET_INVOICE_NOTHING_TO_BILL',
        );
      }

      const billTo = billToFromFleet(fleet);
      const created: InvoiceWithLineItems = await insertInvoiceInTransaction(tx, {
        driverId: null,
        currency,
        lines: plan.lines,
        chargedCents: plan.totalCents,
        status: 'issued',
        paymentTermsDays: fleet.paymentTermsDays,
        fleet: {
          fleetId,
          periodStart: bounds.periodStart,
          periodEnd: bounds.periodEnd,
          billTo: { ...billTo },
          language: isInvoiceLanguage(fleet.invoiceLanguage) ? fleet.invoiceLanguage : 'en',
        },
        sessionClaimGuard,
      });
      const result: FleetInvoiceResult = {
        ...created,
        drivers: plan.drivers,
        excluded: plan.excluded.slice(0, FLEET_INVOICE_EXCLUDED_LIMIT),
        excludedCount: plan.excluded.length,
      };
      return result;
    });
  } catch (err) {
    if (err instanceof AppError) throw err;
    if (pgErrorCode(err) === PG_UNIQUE_VIOLATION && pgConstraintName(err) === FLEET_PERIOD_INDEX) {
      const live = await findPeriodInvoice(db, fleetId, bounds.periodStart);
      if (live != null) throw periodExistsError(live);
    }
    if (err instanceof Error && err.message === 'Session is already invoiced') {
      throw new AppError(
        'A session of the fleet was billed while the invoice was being created; generate it again',
        400,
        'INVOICE_CREATION_FAILED',
      );
    }
    throw err;
  }
}
