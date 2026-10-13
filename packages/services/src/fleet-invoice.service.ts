// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { sql, type SQL } from 'drizzle-orm';
import {
  db,
  chargingSessions,
  getCompanyCurrency,
  getSystemTimezone,
  pgConstraintName,
  pgErrorCode,
  PG_UNIQUE_VIOLATION,
} from '@evtivity/database';
import {
  AppError,
  dimensionAmounts,
  isValidTimezone,
  taxTotals,
  zonedMidnight,
} from '@evtivity/lib';
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

/** The unique index of one live fleet invoice per fleet and period. */
const FLEET_PERIOD_INDEX = 'uq_invoices_fleet_period';

/** The unique index of one live member invoice per fleet, driver and period. */
const MEMBER_PERIOD_INDEX = 'uq_invoices_member_period';

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

/**
 * The bill-to block snapshotted onto an account invoice (GoBD): the fleet
 * billing profile on a fleet invoice, the driver's billing address on a
 * member invoice.
 */
export interface FleetBillTo {
  /** The legal name, else the fleet name; on a member invoice the driver's billing name. */
  name: string;
  street: string | null;
  city: string | null;
  state: string | null;
  zip: string | null;
  country: string | null;
  taxId: string | null;
  /** Member invoice: the driver's email at issue, printed after the address lines. */
  email?: string | null;
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

/** The driver fields a member invoice reads. */
export interface DriverForInvoice {
  id: string;
  firstName: string;
  lastName: string;
  email: string | null;
  language: string;
  billingName: string | null;
  billingStreet: string | null;
  billingCity: string | null;
  billingState: string | null;
  billingZip: string | null;
  billingCountry: string | null;
}

function blankToNull(value: string | null): string | null {
  const trimmed = value?.trim() ?? '';
  return trimmed !== '' ? trimmed : null;
}

/** The driver's full name, else the email, else the driver id. */
function driverDisplayName(driver: DriverForInvoice): string {
  const full = `${driver.firstName} ${driver.lastName}`.trim();
  return full !== '' ? full : (blankToNull(driver.email) ?? driver.id);
}

/**
 * The bill-to block of a member invoice: the billing name (else the driver's
 * name), the driver's billing address, no tax ID (private persons), and the
 * driver's email, so an invoice without an address still names its recipient
 * (owner decision: a missing address warns and does not block).
 */
export function billToFromDriver(driver: DriverForInvoice): FleetBillTo {
  return {
    name: blankToNull(driver.billingName) ?? driverDisplayName(driver),
    street: blankToNull(driver.billingStreet),
    city: blankToNull(driver.billingCity),
    state: blankToNull(driver.billingState),
    zip: blankToNull(driver.billingZip),
    country: blankToNull(driver.billingCountry),
    taxId: null,
    email: blankToNull(driver.email),
  };
}

/** A postal address needs at least the street and the city. */
export function driverHasBillingAddress(driver: DriverForInvoice): boolean {
  return blankToNull(driver.billingStreet) != null && blankToNull(driver.billingCity) != null;
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
 * invoice_id. `scope` picks the recipient: the fleet's own sessions (default,
 * not member billed: those go on the member's own invoice), one member's
 * member-billed sessions, or every member's.
 * `lock` takes the selected session rows (`FOR UPDATE OF cs`)
 * in the caller's transaction, so nothing can bill or change them before the
 * invoice claims them. With `startsAt` (the scheduled run), only sessions
 * ended in the month itself: earlier months get their own invoice.
 */
export async function loadFleetInvoiceCandidates(
  executor: Executor,
  fleetId: string,
  endsAt: Date,
  options: { lock?: boolean; startsAt?: Date; scope?: AccountSessionScope } = {},
): Promise<FleetSessionCandidate[]> {
  const scope = options.scope ?? { kind: 'fleet' };
  const recipient =
    scope.kind === 'fleet'
      ? sql`AND NOT cs.member_billed`
      : scope.kind === 'member'
        ? sql`AND cs.member_billed AND cs.driver_id = ${scope.driverId}`
        : sql`AND cs.member_billed`;
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
      ${recipient}
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

/**
 * Which account sessions of a fleet: the fleet's own (billed on the fleet
 * invoice), one member's (billed on that driver's member invoice), or every
 * member's (the preview).
 */
export type AccountSessionScope =
  | { kind: 'fleet' }
  | { kind: 'member'; driverId: string }
  | { kind: 'members' };

/** A numeric column as postgres.js returns it (a string), or null. */
function numericText(value: unknown): string | null {
  if (typeof value === 'string') return value;
  if (typeof value === 'number') return String(value);
  return null;
}

/**
 * The live fleet invoice of a fleet and period (not void, not credited, not a
 * member invoice), if any.
 */
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
      AND kind = 'invoice' AND status NOT IN ('void', 'credited') AND NOT member_billed
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

function periodInvoiceOf(row: Record<string, unknown>): FleetPeriodInvoice {
  return {
    id: String(row['id']),
    invoiceNumber: String(row['invoice_number']),
    status: String(row['status']),
  };
}

/** The live member invoice of a driver, fleet and period (not void, not credited), if any. */
export async function findMemberPeriodInvoice(
  executor: Executor,
  fleetId: string,
  driverId: string,
  periodStart: string,
): Promise<FleetPeriodInvoice | null> {
  const rows = (await executor.execute(sql`
    SELECT id, invoice_number, status FROM invoices
    WHERE fleet_id = ${fleetId} AND driver_id = ${driverId} AND period_start = ${periodStart}::date
      AND kind = 'invoice' AND status NOT IN ('void', 'credited') AND member_billed
    LIMIT 1
  `)) as unknown as Array<Record<string, unknown>>;
  const row = rows[0];
  return row == null ? null : periodInvoiceOf(row);
}

/** The live member invoices of a fleet and period, by driver id. */
async function findMemberPeriodInvoices(
  executor: Executor,
  fleetId: string,
  periodStart: string,
): Promise<Map<string, FleetPeriodInvoice>> {
  const rows = (await executor.execute(sql`
    SELECT i.driver_id, i.id, i.invoice_number, i.status FROM invoices i
    WHERE i.fleet_id = ${fleetId} AND i.period_start = ${periodStart}::date
      AND i.kind = 'invoice' AND i.status NOT IN ('void', 'credited') AND i.member_billed
      AND i.driver_id IS NOT NULL
  `)) as unknown as Array<Record<string, unknown>>;
  return new Map(rows.map((row) => [String(row['driver_id']), periodInvoiceOf(row)]));
}

/** The drivers a member invoice or the member preview reads, by id. */
async function loadDrivers(
  executor: Executor,
  driverIds: string[],
): Promise<Map<string, DriverForInvoice>> {
  if (driverIds.length === 0) return new Map();
  const rows = (await executor.execute(sql`
    SELECT id, first_name, last_name, email, language, billing_name, billing_street,
           billing_city, billing_state, billing_zip, billing_country
    FROM drivers WHERE id IN (${sql.join(
      driverIds.map((id) => sql`${id}`),
      sql`, `,
    )})
  `)) as unknown as Array<Record<string, unknown>>;
  const drivers = new Map<string, DriverForInvoice>();
  for (const row of rows) {
    const text = (key: string): string | null => {
      const value = row[key];
      return typeof value === 'string' ? value : null;
    };
    const id = String(row['id']);
    drivers.set(id, {
      id,
      firstName: text('first_name') ?? '',
      lastName: text('last_name') ?? '',
      email: text('email'),
      language: text('language') ?? 'en',
      billingName: text('billing_name'),
      billingStreet: text('billing_street'),
      billingCity: text('billing_city'),
      billingState: text('billing_state'),
      billingZip: text('billing_zip'),
      billingCountry: text('billing_country'),
    });
  }
  return drivers;
}

async function loadDriver(executor: Executor, driverId: string): Promise<DriverForInvoice | null> {
  return (await loadDrivers(executor, [driverId])).get(driverId) ?? null;
}

function driverNotFound(): AppError {
  return new AppError('Driver not found', 404, 'DRIVER_NOT_FOUND');
}

/** Who an account invoice bills: the fleet, or one driver of it (a member invoice). */
type AccountInvoiceTarget =
  | { kind: 'fleet'; fleetId: string }
  | { kind: 'member'; fleetId: string; driverId: string };

function findTargetPeriodInvoice(
  executor: Executor,
  target: AccountInvoiceTarget,
  periodStart: string,
): Promise<FleetPeriodInvoice | null> {
  return target.kind === 'fleet'
    ? findPeriodInvoice(executor, target.fleetId, periodStart)
    : findMemberPeriodInvoice(executor, target.fleetId, target.driverId, periodStart);
}

function periodExistsError(target: AccountInvoiceTarget, existing: FleetPeriodInvoice): AppError {
  const holder = target.kind === 'fleet' ? 'The fleet' : 'The driver';
  return new AppError(
    `${holder} already has invoice ${existing.invoiceNumber} for this period; credit it to bill the period again`,
    409,
    'FLEET_INVOICE_PERIOD_EXISTS',
  );
}

function nothingToBillError(target: AccountInvoiceTarget): AppError {
  return new AppError(
    target.kind === 'fleet'
      ? 'The fleet has no unbilled account session with a cost in this period'
      : 'The driver has no unbilled member session of the fleet with a cost in this period',
    409,
    'FLEET_INVOICE_NOTHING_TO_BILL',
  );
}

/**
 * Which sessions the claim of an account invoice may take: still billed on
 * account to the fleet, with no payment record, and of the invoice's
 * recipient (the fleet's own, or the driver's member-billed sessions).
 */
function accountClaimGuard(target: AccountInvoiceTarget): SQL {
  const recipient =
    target.kind === 'fleet'
      ? sql`AND NOT ${chargingSessions.memberBilled}`
      : sql`AND ${chargingSessions.memberBilled} AND ${chargingSessions.driverId} = ${target.driverId}`;
  return sql`${chargingSessions.billingMode} = 'account'
    AND ${chargingSessions.billingFleetId} = ${target.fleetId}
    ${recipient}
    AND NOT EXISTS (SELECT 1 FROM payment_records fpr WHERE fpr.session_id = ${chargingSessions.id})`;
}

/** Refuses a period that has not started yet in the system timezone. */
function assertPeriodStarted(bounds: FleetInvoicePeriod, now: Date): void {
  if (bounds.startsAt.getTime() > now.getTime()) {
    throw new AppError('period must not be in the future', 400, 'VALIDATION_ERROR');
  }
}

/** One member's sessions the member invoice of a period would bill (preview). */
export interface FleetInvoiceMemberTotal {
  driverId: string;
  driverName: string;
  sessionCount: number;
  energyWh: number;
  netCents: number;
  taxCents: number;
  totalCents: number;
  /** The driver's live member invoice of the period; generating again is refused while it exists. */
  existingInvoice: FleetPeriodInvoice | null;
  /** The driver has an email: the invoice can be emailed. */
  hasEmail: boolean;
  /** The driver has a billing address (street and city); without one the invoice prints name and email. */
  hasAddress: boolean;
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
  /**
   * Member invoices of the period: each driver with unbilled member-billed
   * sessions with a cost or a live member invoice of the period, ordered by
   * name. The totals above cover the fleet's own sessions only.
   */
  members: FleetInvoiceMemberTotal[];
}

/**
 * The unbilled account sessions of a fleet the invoice of `period` would bill,
 * per driver, and the ones it would leave off, plus what each member invoice
 * of the period would bill (`members`). Reads only. Throws FLEET_NOT_FOUND
 * (404) and VALIDATION_ERROR (400) for a malformed period.
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
  const [candidates, existingInvoice, memberCandidates, memberInvoices] = await Promise.all([
    loadFleetInvoiceCandidates(db, fleetId, bounds.endsAt),
    findPeriodInvoice(db, fleetId, bounds.periodStart),
    loadFleetInvoiceCandidates(db, fleetId, bounds.endsAt, { scope: { kind: 'members' } }),
    findMemberPeriodInvoices(db, fleetId, bounds.periodStart),
  ]);
  const plan = planFleetInvoice(candidates, currency, timeZone);
  const members = await previewMembers(
    planFleetInvoice(memberCandidates, currency, timeZone).drivers,
    memberInvoices,
  );
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
    members,
  };
}

/** The member rows of the preview: billable totals and live invoices, per driver. */
async function previewMembers(
  totals: FleetInvoiceDriverTotal[],
  invoices: Map<string, FleetPeriodInvoice>,
): Promise<FleetInvoiceMemberTotal[]> {
  const byDriver = new Map<string, FleetInvoiceDriverTotal>();
  // A member-billed session always has a driver (charging_sessions_member_billed_check).
  for (const total of totals) if (total.driverId != null) byDriver.set(total.driverId, total);
  const driverIds = [...new Set([...byDriver.keys(), ...invoices.keys()])];
  const drivers = await loadDrivers(db, driverIds);
  const rows = driverIds.map((driverId): FleetInvoiceMemberTotal => {
    const total = byDriver.get(driverId);
    const driver = drivers.get(driverId);
    return {
      driverId,
      driverName: driver != null ? driverDisplayName(driver) : (total?.driverName ?? ''),
      sessionCount: total?.sessionCount ?? 0,
      energyWh: total?.energyWh ?? 0,
      netCents: total?.netCents ?? 0,
      taxCents: total?.taxCents ?? 0,
      totalCents: total?.totalCents ?? 0,
      existingInvoice: invoices.get(driverId) ?? null,
      hasEmail: driver != null && blankToNull(driver.email) != null,
      hasAddress: driver != null && driverHasBillingAddress(driver),
    };
  });
  return rows.sort(compareDrivers);
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
  return issueAccountInvoice({ kind: 'fleet', fleetId }, period, now, options);
}

/**
 * Issues the member invoice of a calendar month for one driver of a fleet
 * that invoices its members (features/fleet-billing.md, Member invoices):
 * the driver's member-billed account sessions of the fleet that no invoice
 * billed, ended before the end of the month, in the company currency and with
 * a cost. Same rules as the fleet invoice (issued directly, gap-free number
 * allocated after the locked read, the fleet's payment terms), with the
 * driver's bill-to block (billToFromDriver) and language (else English).
 * The driver need not be a current member: a leaver's unbilled member
 * sessions stay billable to them.
 *
 * One live member invoice per driver, fleet and period: refused with
 * FLEET_INVOICE_PERIOD_EXISTS (409) before and under the fleet lock, and by
 * the unique index uq_invoices_member_period at the database. The claim guard
 * takes only the driver's member-billed sessions still billed on account to
 * the fleet.
 *
 * Throws FLEET_NOT_FOUND (404), DRIVER_NOT_FOUND (404), VALIDATION_ERROR
 * (400) for a malformed or future period, FLEET_INVOICE_NOTHING_TO_BILL (409)
 * and INVOICE_CREATION_FAILED (400) as createFleetInvoice.
 */
export async function createMemberInvoice(
  fleetId: string,
  driverId: string,
  period: string,
  now: Date = new Date(),
  options: { periodOnly?: boolean } = {},
): Promise<FleetInvoiceResult> {
  return issueAccountInvoice({ kind: 'member', fleetId, driverId }, period, now, options);
}

/**
 * The drivers "Invoice All Members" issues a member invoice for (the batch
 * route and its worker fan-out): each driver with a member-billed session of
 * the fleet the member invoice of `period` would bill (account, completed, no
 * invoice, no payment record, ended before the end of the month, a cost above
 * zero in the company currency; no lower bound, like the on-demand route) and
 * no live member invoice of the period. Ordered by driver id. Reads only.
 * Throws FLEET_NOT_FOUND (404), VALIDATION_ERROR (400) for a malformed or
 * future period.
 */
export async function listMemberInvoiceDrivers(
  fleetId: string,
  period: string,
  now: Date = new Date(),
): Promise<string[]> {
  const timeZone = await getSystemTimezone();
  const bounds = fleetInvoicePeriod(period, timeZone);
  assertPeriodStarted(bounds, now);
  if ((await loadFleet(db, fleetId)) == null) throw fleetNotFound();
  const currency = await getCompanyCurrency();
  const rows = (await db.execute(sql`
    SELECT DISTINCT cs.driver_id
    FROM charging_sessions cs
    WHERE cs.billing_fleet_id = ${fleetId}
      AND cs.billing_mode = 'account'
      AND cs.member_billed
      AND cs.driver_id IS NOT NULL
      AND cs.status = 'completed'
      AND cs.invoice_id IS NULL
      AND cs.ended_at < ${bounds.endsAt.toISOString()}::timestamptz
      AND cs.final_cost_cents > 0
      AND upper(cs.currency) = ${currency.toUpperCase()}
      AND NOT EXISTS (SELECT 1 FROM payment_records pr WHERE pr.session_id = cs.id)
      AND NOT EXISTS (
        SELECT 1 FROM invoices i
        WHERE i.fleet_id = cs.billing_fleet_id AND i.driver_id = cs.driver_id
          AND i.period_start = ${bounds.periodStart}::date AND i.kind = 'invoice'
          AND i.status NOT IN ('void', 'credited') AND i.member_billed)
    ORDER BY cs.driver_id
  `)) as unknown as Array<Record<string, unknown>>;
  return rows.map((row) => String(row['driver_id']));
}

/** The one writer of account invoices: a fleet invoice or a member invoice. */
async function issueAccountInvoice(
  target: AccountInvoiceTarget,
  period: string,
  now: Date,
  options: { periodOnly?: boolean },
): Promise<FleetInvoiceResult> {
  const { fleetId } = target;
  const timeZone = await getSystemTimezone();
  const bounds = fleetInvoicePeriod(period, timeZone);
  assertPeriodStarted(bounds, now);
  // Fast refusals before the transaction; each is checked again under the lock.
  if ((await loadFleet(db, fleetId)) == null) throw fleetNotFound();
  if (target.kind === 'member' && (await loadDriver(db, target.driverId)) == null) {
    throw driverNotFound();
  }
  const existing = await findTargetPeriodInvoice(db, target, bounds.periodStart);
  if (existing != null) throw periodExistsError(target, existing);

  const currency = await getCompanyCurrency();
  const sessionClaimGuard = accountClaimGuard(target);

  try {
    return await db.transaction(async (tx: InvoiceTx) => {
      // Generations of one fleet (fleet and member invoices alike) run one
      // after the other; the second sees the first's invoice and claimed sessions.
      const fleet = await loadFleet(tx, fleetId, true);
      if (fleet == null) throw fleetNotFound();
      const driver = target.kind === 'member' ? await loadDriver(tx, target.driverId) : null;
      if (target.kind === 'member' && driver == null) throw driverNotFound();
      const live = await findTargetPeriodInvoice(tx, target, bounds.periodStart);
      if (live != null) throw periodExistsError(target, live);

      const candidates = await loadFleetInvoiceCandidates(tx, fleetId, bounds.endsAt, {
        lock: true,
        scope:
          target.kind === 'fleet'
            ? { kind: 'fleet' }
            : { kind: 'member', driverId: target.driverId },
        ...(options.periodOnly === true ? { startsAt: bounds.startsAt } : {}),
      });
      const plan = planFleetInvoice(candidates, currency, timeZone);
      if (plan.sessions.length === 0) throw nothingToBillError(target);

      const billTo = driver != null ? billToFromDriver(driver) : billToFromFleet(fleet);
      const language = driver != null ? driver.language : fleet.invoiceLanguage;
      const created: InvoiceWithLineItems = await insertInvoiceInTransaction(tx, {
        driverId: driver?.id ?? null,
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
          language: isInvoiceLanguage(language) ? language : 'en',
          memberBilled: driver != null,
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
    const periodIndex = target.kind === 'fleet' ? FLEET_PERIOD_INDEX : MEMBER_PERIOD_INDEX;
    if (pgErrorCode(err) === PG_UNIQUE_VIOLATION && pgConstraintName(err) === periodIndex) {
      const live = await findTargetPeriodInvoice(db, target, bounds.periodStart);
      if (live != null) throw periodExistsError(target, live);
    }
    if (err instanceof Error && err.message === 'Session is already invoiced') {
      throw new AppError(
        target.kind === 'fleet'
          ? 'A session of the fleet was billed while the invoice was being created; generate it again'
          : 'A session of the driver was billed while the invoice was being created; generate it again',
        400,
        'INVOICE_CREATION_FAILED',
      );
    }
    throw err;
  }
}
