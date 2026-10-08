// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { eq, and, sql, isNull, isNotNull, between, asc, ne, inArray } from 'drizzle-orm';
import type { SQL } from 'drizzle-orm';
import {
  db,
  invoices,
  invoiceLineItems,
  chargingSessions,
  drivers,
  fleets,
  paymentRecords,
  getCompanyCurrency,
  getInvoicePaymentTermsDays,
  allocateInvoiceNumber,
} from '@evtivity/database';
import {
  chargedCostBreakdown,
  splitGrossByTaxRate,
  dimensionAmounts,
  COST_DIMENSIONS,
  taxTotals,
  taxBreakdownWithGross,
  AppError,
  createLogger,
  storedCostBreakdown,
} from '@evtivity/lib';
import type {
  CostDimension,
  CostTaxLine,
  SessionCostBreakdown,
  TaxBasis,
  TaxLine,
  TaxBreakdownLine,
} from '@evtivity/lib';
import { claimFeeRecordsForInvoice, releaseInvoiceFeeRecords } from '@evtivity/payments';
import { inCompanyCurrency, sessionCurrencySql } from './company-currency.js';

const logger = createLogger('invoice-service');

const DAY_MS = 24 * 60 * 60 * 1000;

type Invoice = typeof invoices.$inferSelect;

export interface InvoiceDriver {
  id: string;
  firstName: string;
  lastName: string;
  email: string | null;
  /** The driver's preferred language; the invoice PDF renders in it. */
  language: string;
}

export interface InvoiceWithLineItems {
  invoice: Invoice;
  lineItems: Array<typeof invoiceLineItems.$inferSelect>;
}

/** The other side of a credit: the credited invoice, or the credit note that credited it. */
export interface InvoiceReference {
  id: string;
  invoiceNumber: string;
  issuedAt: Date | null;
  /** When the credited invoice was paid; a refund of that money is made outside EVtivity. */
  paidAt: Date | null;
}

/** The fleet a fleet invoice (or its credit note) bills. */
export interface InvoiceFleet {
  id: string;
  name: string;
}

export interface InvoiceDetail extends InvoiceWithLineItems {
  driver: InvoiceDriver | null;
  /** On a fleet invoice or its credit note: the billed fleet. Null otherwise. */
  fleet: InvoiceFleet | null;
  /** Net amount, tax rate, tax amount, and gross per rate, from the line items. */
  taxBreakdown: TaxBreakdownLine[];
  /** On a credit note: the invoice it credits. Null otherwise. */
  creditedInvoice: InvoiceReference | null;
  /** On a credited invoice: the credit note that credited it. Null otherwise. */
  creditNote: InvoiceReference | null;
}

const referenceColumns = {
  id: invoices.id,
  invoiceNumber: invoices.invoiceNumber,
  issuedAt: invoices.issuedAt,
  paidAt: invoices.paidAt,
};

/** What a line item bills. Renderers localize the description from it. */
export type InvoiceLineKind =
  | 'energy'
  | 'time'
  | 'sessionFee'
  | 'idleFee'
  | 'reservationFee'
  | 'session'
  | 'cancellationFee'
  | 'noShowFee';

export interface InvoiceLineMetadata {
  kind: InvoiceLineKind;
  /** 1-based tariff segment of a split session. */
  segment?: number;
  /** Session end date (YYYY-MM-DD, UTC) on 'session' lines. */
  sessionDate?: string;
  /** Energy delivered in Wh on 'session' lines. */
  energyWh?: number;
  /** Charge date (YYYY-MM-DD, UTC) on reservation fee lines. */
  chargeDate?: string;
  /** Fleet invoice 'session' lines: the driver who charged (the PDF groups by it). */
  driverId?: string;
  /** Fleet invoice 'session' lines: the driver's name at issue. */
  driverName?: string;
  /** Fleet invoice 'session' lines: the station's name or OCPP id at issue. */
  stationName?: string;
  /**
   * Fleet invoice 'idleFee' lines: the idle minutes billed, from the stored
   * cost breakdown. Absent when the breakdown does not record them.
   */
  idleMinutes?: number;
}

/** A line item before it is inserted. */
export interface LineDraft {
  sessionId: string | null;
  /** The reservation fee payment record a fee line invoices. */
  paymentRecordId?: number | null;
  description: string;
  metadata: InvoiceLineMetadata;
  taxRate: number;
  netCents: number;
  taxCents: number;
}

export interface SessionForInvoice extends SessionPayment {
  id: string;
  invoiceId: string | null;
  driverId: string | null;
  energyDeliveredWh: string | null;
  endedAt: Date | null;
  finalCostCents: number;
  tariffTaxRate: string | null;
  costBreakdown: unknown;
}

const sessionColumns = {
  id: chargingSessions.id,
  invoiceId: chargingSessions.invoiceId,
  driverId: chargingSessions.driverId,
  energyDeliveredWh: chargingSessions.energyDeliveredWh,
  endedAt: chargingSessions.endedAt,
  tariffTaxRate: chargingSessions.tariffTaxRate,
  costBreakdown: chargingSessions.costBreakdown,
};

/** The session's payment record (one per session), left-joined on session_id. */
const sessionPaymentColumns = {
  paymentStatus: paymentRecords.status,
  paymentCapturedCents: paymentRecords.capturedAmountCents,
};

/**
 * Payment states in which the charge was collected. A later refund does not
 * reopen it: the driver paid, the refund is its own record.
 */
const COLLECTED_PAYMENT_STATUSES: ReadonlySet<string> = new Set([
  'captured',
  'partially_refunded',
  'refunded',
]);

export interface SessionPayment {
  finalCostCents: number;
  paymentStatus?: string | null;
  paymentCapturedCents?: number | null;
}

/**
 * Whether the driver already paid what the session cost: it cost nothing, or
 * its payment record was captured for at least the final cost. A session
 * without a payment record (billed by invoice), with a failed or pending
 * payment, or with a shortfall (captured less than the final cost) is not.
 */
export function isSessionCollected(session: SessionPayment): boolean {
  if (session.finalCostCents === 0) return true;
  return (
    session.paymentStatus != null &&
    COLLECTED_PAYMENT_STATUSES.has(session.paymentStatus) &&
    (session.paymentCapturedCents ?? 0) >= session.finalCostCents
  );
}

/**
 * Status of a new invoice: `paid` when every session on it was collected
 * (reservation fee lines are captured charges by selection), else `issued`.
 */
export function invoiceStatusFor(sessions: SessionPayment[]): 'paid' | 'issued' {
  return sessions.every(isSessionCollected) ? 'paid' : 'issued';
}

function snapshotTaxRate(session: SessionForInvoice): number {
  return session.tariffTaxRate != null ? Number(session.tariffTaxRate) : 0;
}

/**
 * The cost breakdown stored with the session's final cost by the one cost
 * assembly (@evtivity/database session-pricing): tax lines per rate that sum
 * to what the driver was charged and, when calculated from the tariff, the
 * billed components. A session without a stored breakdown for its final cost
 * (written outside the assembly) is split at its snapshot tax rate.
 */
export function sessionCostBreakdown(session: SessionForInvoice): SessionCostBreakdown {
  const stored = storedCostBreakdown({
    costCents: session.finalCostCents,
    costBreakdown: session.costBreakdown,
  });
  if (stored != null) return stored;
  logger.warn(
    { sessionId: session.id, finalCostCents: session.finalCostCents },
    'Session has no stored cost breakdown for its final cost; invoicing it at its snapshot tax rate',
  );
  return chargedCostBreakdown(session.finalCostCents, snapshotTaxRate(session), 'net');
}

/** Line kinds of a session's billed components. */
type ComponentLineKind = Exclude<InvoiceLineKind, 'session' | 'cancellationFee' | 'noShowFee'>;

const COMPONENT_DESCRIPTIONS: Record<ComponentLineKind, string> = {
  energy: 'Energy charge',
  time: 'Time charge',
  sessionFee: 'Session fee',
  idleFee: 'Idle fee',
  reservationFee: 'Reservation fee',
};

const DIMENSION_KINDS: Record<CostDimension, ComponentLineKind> = {
  energyCostCents: 'energy',
  timeCostCents: 'time',
  sessionFeeCents: 'sessionFee',
  idleFeeCents: 'idleFee',
  reservationHoldingFeeCents: 'reservationFee',
};

/**
 * One line per billed component (energy, time, fees) of a cost tax line. The
 * tax of the line is spread over its components with dimensionAmounts, so the
 * lines carry exactly the tax the cost calculator charged, and on the gross
 * basis each line's net plus tax is exactly the gross amount charged for it.
 */
function componentLines(
  sessionId: string,
  line: CostTaxLine,
  segment: number | null,
  basis: TaxBasis,
): LineDraft[] {
  const amounts = dimensionAmounts(line, basis);
  return COST_DIMENSIONS.filter((d) => line[d] > 0).map((dimension) => {
    const kind = DIMENSION_KINDS[dimension];
    const base = COMPONENT_DESCRIPTIONS[kind];
    const description =
      segment != null && kind !== 'sessionFee' && kind !== 'reservationFee'
        ? `Segment ${String(segment)} ${base.toLowerCase()}`
        : base;
    const metadata: InvoiceLineMetadata =
      segment != null && kind !== 'sessionFee' && kind !== 'reservationFee'
        ? { kind, segment }
        : { kind };
    return {
      sessionId,
      description,
      metadata,
      taxRate: line.taxRate,
      netCents: amounts[dimension].netCents,
      taxCents: amounts[dimension].taxCents,
    };
  });
}

/** Component lines of a stored breakdown: per tariff segment, plus a split session's holding fee. */
function linesFromComponents(sessionId: string, breakdown: SessionCostBreakdown): LineDraft[] {
  return (breakdown.components ?? []).flatMap((group) =>
    group.taxLines.flatMap((line) =>
      componentLines(sessionId, line, group.segment, breakdown.basis),
    ),
  );
}

/**
 * One 'session' line per tax rate, describing the session as a whole. A
 * session charged nothing still gets one zero line, so it counts as invoiced.
 */
export function sessionSummaryLines(session: SessionForInvoice, taxLines: TaxLine[]): LineDraft[] {
  const lines = taxLines.length > 0 ? taxLines : [splitGrossByTaxRate(0, snapshotTaxRate(session))];
  const energyWh = session.energyDeliveredWh != null ? Number(session.energyDeliveredWh) : 0;
  const sessionDate = session.endedAt?.toISOString().split('T')[0] ?? 'unknown';
  const description = `Charging session ${sessionDate} (${(energyWh / 1000).toFixed(2)} kWh)`;
  return lines.map((line) => ({
    sessionId: session.id,
    description,
    metadata: { kind: 'session', sessionDate, energyWh },
    taxRate: line.taxRate,
    netCents: line.netCents,
    taxCents: line.taxCents,
  }));
}

/**
 * The line of a reservation fee charge. The fee was priced net and charged
 * with tax at one rate, so its gross splits back exactly (splitGrossByTaxRate).
 */
function feeLine(
  paymentRecordId: number,
  chargeType: string,
  grossCents: number,
  taxRate: number,
  chargedAt: Date,
): LineDraft {
  const noShow = chargeType === 'reservation_no_show';
  const split = splitGrossByTaxRate(grossCents, taxRate);
  return {
    sessionId: null,
    paymentRecordId,
    description: noShow ? 'Reservation no-show fee' : 'Reservation cancellation fee',
    metadata: {
      kind: noShow ? 'noShowFee' : 'cancellationFee',
      chargeDate: chargedAt.toISOString().slice(0, 10),
    },
    taxRate: split.taxRate,
    netCents: split.netCents,
    taxCents: split.taxCents,
  };
}

function grossOf(lines: LineDraft[]): number {
  return taxTotals(lines).grossCents;
}

/**
 * Line items of a single-session invoice: one line per billed component (per
 * tariff segment for split sessions) when the stored breakdown has its
 * components, otherwise one line per tax rate.
 */
function singleSessionLines(session: SessionForInvoice): LineDraft[] {
  const breakdown = sessionCostBreakdown(session);
  const lines = linesFromComponents(session.id, breakdown);
  if (lines.length > 0 && grossOf(lines) === session.finalCostCents) return lines;
  return sessionSummaryLines(session, breakdown.taxLines);
}

// Account sessions (charge on account) without a payment record are billed
// to their fleet on the fleet invoice, never on a driver invoice (P11: the
// query and the claim). One with a payment record (an operator hold) was paid
// by card: the fleet invoice skips it, so a driver invoice may bill it.
const sessionNotOnAccount = sql`NOT (${chargingSessions.billingMode} IS NOT DISTINCT FROM 'account'
  AND NOT EXISTS (SELECT 1 FROM payment_records apr WHERE apr.session_id = ${chargingSessions.id}))`;

/** Thrown when a session of the invoice is already on another invoice. */
export function alreadyInvoicedError(): Error {
  return new Error('Session is already invoiced');
}

/** Thrown when a reservation fee charge of the invoice is already on another invoice. */
function feeAlreadyInvoicedError(): Error {
  return new Error('Reservation fee is already invoiced');
}

/** What a fleet invoice adds to the invoice header (features/fleet-billing.md). */
export interface FleetInvoiceHeader {
  fleetId: string;
  /** First day of the billed month (YYYY-MM-DD). */
  periodStart: string;
  /** Last day of the billed month (YYYY-MM-DD). */
  periodEnd: string;
  /** The fleet billing profile's bill-to block at issue. */
  billTo: Record<string, unknown>;
  /** Language of the invoice PDF and email. */
  language: string;
}

/** The transaction an invoice is inserted in. */
export type InvoiceTx = Parameters<Parameters<typeof db.transaction>[0]>[0];

export interface InsertInvoiceInput {
  driverId: string | null;
  currency: string;
  lines: LineDraft[];
  /** What the sessions and fees were charged: the lines must sum to it. */
  chargedCents: number;
  status: 'paid' | 'issued';
  /** Days from issue to the due date; default the invoice.paymentTermsDays setting. */
  paymentTermsDays?: number | null;
  /** Set on a fleet invoice. */
  fleet?: FleetInvoiceHeader;
  /**
   * Which sessions the claim may take besides the claim column and the
   * line-item guard. Default: sessions not billed on account (driver invoices).
   */
  sessionClaimGuard?: SQL;
}

/**
 * Insert an invoice and its lines in one transaction, and claim its sessions
 * for it: each session's invoice_id is set only while it is null, so a session
 * claimed by a concurrent invoice rolls this one back. The header holds the
 * sum of the lines; it must equal the amount the sessions and fees were
 * charged.
 */
export async function insertInvoice(input: InsertInvoiceInput): Promise<InvoiceWithLineItems> {
  assertLinesMatchCharged(input.lines, input.chargedCents);
  return db.transaction((tx) => insertInvoiceInTransaction(tx, input));
}

function assertLinesMatchCharged(lines: LineDraft[], chargedCents: number): void {
  const grossCents = taxTotals(lines).grossCents;
  if (grossCents !== chargedCents) {
    throw new Error(
      `Invoice lines total ${String(grossCents)} but the sessions were charged ${String(chargedCents)}`,
    );
  }
}

/**
 * insertInvoice inside the caller's transaction, for a caller that locks and
 * reads its sessions in the same transaction first (the fleet invoice): the
 * number is allocated after those reads, so a claim the caller made certain
 * never gives a number back.
 */
export async function insertInvoiceInTransaction(
  tx: InvoiceTx,
  input: InsertInvoiceInput,
): Promise<InvoiceWithLineItems> {
  const { driverId, currency, lines, chargedCents, status } = input;
  assertLinesMatchCharged(lines, chargedCents);
  const totals = taxTotals(lines);

  const now = new Date();
  const termsDays = input.paymentTermsDays ?? (await getInvoicePaymentTermsDays());
  const dueAt = new Date(now.getTime() + termsDays * DAY_MS);
  const sessionIds = [
    ...new Set(lines.map((line) => line.sessionId).filter((id): id is string => id != null)),
  ];
  const feeRecordIds = [
    ...new Set(lines.map((line) => line.paymentRecordId).filter((id): id is number => id != null)),
  ];
  const claimGuard = input.sessionClaimGuard ?? sessionNotOnAccount;

  const invoiceNumber = await allocateInvoiceNumber(tx, 'invoice', now);
  const [invoice] = await tx
    .insert(invoices)
    .values({
      invoiceNumber,
      driverId,
      status,
      issuedAt: now,
      dueAt,
      paidAt: status === 'paid' ? now : null,
      currency,
      subtotalCents: totals.netCents,
      taxCents: totals.taxCents,
      totalCents: totals.grossCents,
      ...(input.fleet != null
        ? {
            fleetId: input.fleet.fleetId,
            periodStart: input.fleet.periodStart,
            periodEnd: input.fleet.periodEnd,
            billTo: input.fleet.billTo,
            language: input.fleet.language,
          }
        : {}),
    })
    .returning();
  if (invoice == null) throw new Error('Failed to create invoice');

  if (sessionIds.length > 0) {
    const claimed = await tx
      .update(chargingSessions)
      .set({ invoiceId: invoice.id })
      .where(
        and(
          inArray(chargingSessions.id, sessionIds),
          isNull(chargingSessions.invoiceId),
          claimGuard,
        ),
      )
      .returning({ id: chargingSessions.id });
    if (claimed.length !== sessionIds.length) throw alreadyInvoicedError();
  }
  const claimedFees = await claimFeeRecordsForInvoice(tx, feeRecordIds, invoice.id);
  if (claimedFees.length !== feeRecordIds.length) throw feeAlreadyInvoicedError();

  const lineItems =
    lines.length > 0
      ? await tx
          .insert(invoiceLineItems)
          .values(
            lines.map((line) => ({
              invoiceId: invoice.id,
              sessionId: line.sessionId,
              description: line.description,
              quantity: '1',
              unitPriceCents: line.netCents,
              totalCents: line.netCents,
              taxCents: line.taxCents,
              taxRate: String(line.taxRate),
              paymentRecordId: line.paymentRecordId ?? null,
              metadata: line.metadata,
            })),
          )
          .returning()
      : [];
  return { invoice, lineItems };
}

export async function createSessionInvoice(sessionId: string): Promise<InvoiceWithLineItems> {
  const [row] = await db
    .select({
      ...sessionColumns,
      ...sessionPaymentColumns,
      finalCostCents: chargingSessions.finalCostCents,
      currency: sessionCurrencySql(),
      status: chargingSessions.status,
      billingMode: chargingSessions.billingMode,
    })
    .from(chargingSessions)
    .leftJoin(paymentRecords, eq(paymentRecords.sessionId, chargingSessions.id))
    .where(eq(chargingSessions.id, sessionId));

  if (row == null) {
    throw new Error('Session not found');
  }

  if (row.status !== 'completed') {
    throw new Error('Session is not completed');
  }

  if (row.billingMode === 'account' && row.paymentStatus == null) {
    throw new Error('Session is billed to a fleet account');
  }

  // A completed session with null finalCostCents indicates the cost-calc
  // path in event-projections never ran (or threw and was swallowed). Issuing
  // a $0 invoice here would silently bill the driver nothing for a
  // successful charge -- worse than failing loudly. The operator needs to
  // resolve the underlying cost-calc gap before an invoice can be issued.
  if (row.finalCostCents == null) {
    throw new Error(
      `Session ${sessionId} has no finalCostCents; cannot invoice an uncosted session`,
    );
  }

  if (row.invoiceId != null) {
    throw alreadyInvoicedError();
  }

  const session: SessionForInvoice = { ...row, finalCostCents: row.finalCostCents };
  const lines = singleSessionLines(session);
  return insertInvoice({
    driverId: session.driverId,
    currency: row.currency,
    lines,
    chargedCents: session.finalCostCents,
    status: invoiceStatusFor([session]),
  });
}

export async function createAggregatedInvoice(
  driverId: string,
  startDate: Date,
  endDate: Date,
): Promise<InvoiceWithLineItems> {
  // Sessions billed in another currency stay uninvoiced here; they can still be invoiced one by one.
  const currency = await getCompanyCurrency();
  const rows = await db
    .select({
      ...sessionColumns,
      ...sessionPaymentColumns,
      finalCostCents: chargingSessions.finalCostCents,
    })
    .from(chargingSessions)
    .leftJoin(paymentRecords, eq(paymentRecords.sessionId, chargingSessions.id))
    .where(
      and(
        eq(chargingSessions.driverId, driverId),
        eq(chargingSessions.status, 'completed'),
        // Skip uncosted sessions instead of silently aggregating them at $0.
        // A completed session with null finalCostCents is a cost-calc gap
        // that needs operator triage; rolling it into a monthly invoice would
        // hide the problem. Operators noticing fewer sessions than expected
        // can investigate the unbilled ones individually.
        isNotNull(chargingSessions.finalCostCents),
        between(chargingSessions.endedAt, startDate, endDate),
        isNull(chargingSessions.invoiceId),
        sessionNotOnAccount,
        inCompanyCurrency(chargingSessions.currency, currency),
      ),
    )
    .orderBy(asc(chargingSessions.endedAt));

  // Reservation cancellation and no-show fees charged in the range and not
  // invoiced yet, at the tax rate they were charged with.
  const fees = await db
    .select({
      id: paymentRecords.id,
      chargeType: paymentRecords.chargeType,
      capturedAmountCents: paymentRecords.capturedAmountCents,
      taxRate: paymentRecords.taxRate,
      createdAt: paymentRecords.createdAt,
    })
    .from(paymentRecords)
    .where(
      and(
        eq(paymentRecords.driverId, driverId),
        ne(paymentRecords.chargeType, 'session'),
        inArray(paymentRecords.status, ['captured', 'partially_refunded', 'refunded']),
        isNotNull(paymentRecords.capturedAmountCents),
        between(paymentRecords.createdAt, startDate, endDate),
        isNull(paymentRecords.invoiceId),
        inCompanyCurrency(paymentRecords.currency, currency),
      ),
    )
    .orderBy(asc(paymentRecords.createdAt));

  if (rows.length === 0 && fees.length === 0) {
    throw new AppError(
      'No uninvoiced sessions found for this driver in the given date range',
      400,
      'INVOICE_NO_SESSIONS',
    );
  }

  const lines: LineDraft[] = [];
  const sessions: SessionForInvoice[] = [];
  let chargedCents = 0;
  for (const row of rows) {
    const session: SessionForInvoice = { ...row, finalCostCents: row.finalCostCents ?? 0 };
    sessions.push(session);
    chargedCents += session.finalCostCents;
    lines.push(...sessionSummaryLines(session, sessionCostBreakdown(session).taxLines));
  }
  for (const fee of fees) {
    const gross = fee.capturedAmountCents ?? 0;
    chargedCents += gross;
    lines.push(feeLine(fee.id, fee.chargeType, gross, Number(fee.taxRate ?? 0), fee.createdAt));
  }

  return insertInvoice({
    driverId,
    currency,
    lines,
    chargedCents,
    status: invoiceStatusFor(sessions),
  });
}

export async function getInvoice(invoiceId: string): Promise<InvoiceDetail | null> {
  const [invoice] = await db.select().from(invoices).where(eq(invoices.id, invoiceId));

  if (invoice == null) {
    return null;
  }

  const lineItems = await db
    .select()
    .from(invoiceLineItems)
    .where(eq(invoiceLineItems.invoiceId, invoiceId))
    .orderBy(asc(invoiceLineItems.id));

  let driver: InvoiceDriver | null = null;
  if (invoice.driverId != null) {
    const [row] = await db
      .select({
        id: drivers.id,
        firstName: drivers.firstName,
        lastName: drivers.lastName,
        email: drivers.email,
        language: drivers.language,
      })
      .from(drivers)
      .where(eq(drivers.id, invoice.driverId));
    driver = row ?? null;
  }

  const taxBreakdown = taxBreakdownWithGross(
    lineItems.map((item) => ({
      taxRate: Number(item.taxRate),
      netCents: item.totalCents,
      taxCents: item.taxCents,
    })),
  );

  let fleet: InvoiceFleet | null = null;
  if (invoice.fleetId != null) {
    const [row] = await db
      .select({ id: fleets.id, name: fleets.name })
      .from(fleets)
      .where(eq(fleets.id, invoice.fleetId));
    fleet = row ?? null;
  }

  let creditedInvoice: InvoiceReference | null = null;
  if (invoice.creditedInvoiceId != null) {
    const [row] = await db
      .select(referenceColumns)
      .from(invoices)
      .where(eq(invoices.id, invoice.creditedInvoiceId));
    creditedInvoice = row ?? null;
  }
  let creditNote: InvoiceReference | null = null;
  if (invoice.status === 'credited') {
    const [row] = await db
      .select(referenceColumns)
      .from(invoices)
      .where(eq(invoices.creditedInvoiceId, invoice.id));
    creditNote = row ?? null;
  }

  return { invoice, lineItems, driver, fleet, taxBreakdown, creditedInvoice, creditNote };
}

export interface InvoiceChange {
  before: Invoice;
  invoice: Invoice;
}

export interface VoidResult extends InvoiceChange {
  /** Sessions the void released, so they can be invoiced again. */
  releasedSessionIds: string[];
  /** Reservation fee charges (payment record ids) the void released. */
  releasedFeeRecordIds: number[];
}

function notVoidableError(status: Invoice['status']): AppError {
  return new AppError(
    `Only a draft invoice can be voided; this invoice is ${status}. Issue a credit note to correct an issued invoice`,
    409,
    'INVOICE_NOT_VOIDABLE',
  );
}

/**
 * Marks a draft invoice void and releases its sessions and reservation fee
 * charges (invoice_id back to null), in one transaction, so they can be
 * invoiced again. An issued, paid or credited invoice and a credit note are
 * never voided (GoBD): INVOICE_NOT_VOIDABLE (409); a credit note corrects an
 * issued invoice. Voiding an already void invoice changes nothing: before and
 * invoice are the same row and nothing is released. Null when the invoice does
 * not exist.
 */
export async function voidInvoice(invoiceId: string): Promise<VoidResult | null> {
  return db.transaction(async (tx) => {
    // Locked, so a concurrent credit or void waits and this one sees its result.
    const [before] = await tx
      .select()
      .from(invoices)
      .where(eq(invoices.id, invoiceId))
      .for('update');
    if (before == null) return null;
    const unchanged = { before, invoice: before, releasedSessionIds: [], releasedFeeRecordIds: [] };
    if (before.status === 'void') return unchanged;
    if (before.status !== 'draft') throw notVoidableError(before.status);

    const [updated] = await tx
      .update(invoices)
      .set({ status: 'void', updatedAt: new Date() })
      .where(and(eq(invoices.id, invoiceId), eq(invoices.status, 'draft')))
      .returning();
    // The row is locked, so its status cannot have changed since the select.
    if (updated == null) throw notVoidableError(before.status);

    const sessions = await tx
      .update(chargingSessions)
      .set({ invoiceId: null })
      .where(eq(chargingSessions.invoiceId, invoiceId))
      .returning({ id: chargingSessions.id });
    const releasedFeeRecordIds = await releaseInvoiceFeeRecords(tx, invoiceId);
    return {
      before,
      invoice: updated,
      releasedSessionIds: sessions.map((session) => session.id),
      releasedFeeRecordIds,
    };
  });
}

function notPayableError(status: Invoice['status']): AppError {
  if (status === 'paid') {
    return new AppError('Invoice is already paid', 409, 'INVOICE_ALREADY_PAID');
  }
  return new AppError(
    `Only an issued invoice can be marked paid; this invoice is ${status}`,
    409,
    'INVOICE_NOT_ISSUED',
  );
}

/** Thrown when an action for invoices targets a credit note. */
export function creditNoteError(): AppError {
  return new AppError(
    'This is a credit note; it cannot be marked paid or credited',
    409,
    'INVOICE_IS_CREDIT_NOTE',
  );
}

export interface MarkInvoicePaidInput {
  /** When the payment was received. */
  paidAt: Date;
  /** The operator's note of the payment, such as a bank transfer reference. */
  reference: string | null;
}

/**
 * Records a payment received outside EVtivity: an issued invoice moves to
 * paid with paidAt and the reference. A paidAt before the issue time is a
 * VALIDATION_ERROR (400). Throws INVOICE_ALREADY_PAID (409) for a
 * paid invoice, INVOICE_IS_CREDIT_NOTE (409) for a credit note, and
 * INVOICE_NOT_ISSUED (409) for a draft, void or credited one, also
 * when a concurrent request changed the status first. Null when the invoice
 * does not exist.
 */
export async function markInvoicePaid(
  invoiceId: string,
  input: MarkInvoicePaidInput,
): Promise<InvoiceChange | null> {
  const [before] = await db.select().from(invoices).where(eq(invoices.id, invoiceId));
  if (before == null) return null;
  if (before.kind === 'credit_note') throw creditNoteError();
  if (before.status !== 'issued') throw notPayableError(before.status);
  if (before.issuedAt != null && input.paidAt.getTime() < before.issuedAt.getTime()) {
    throw new AppError('paidAt must not be before the invoice was issued', 400, 'VALIDATION_ERROR');
  }

  const [updated] = await db
    .update(invoices)
    .set({
      status: 'paid',
      paidAt: input.paidAt,
      paymentReference: input.reference,
      updatedAt: new Date(),
    })
    .where(and(eq(invoices.id, invoiceId), eq(invoices.status, 'issued')))
    .returning();
  if (updated != null) return { before, invoice: updated };

  const [current] = await db
    .select({ status: invoices.status })
    .from(invoices)
    .where(eq(invoices.id, invoiceId));
  if (current == null) return null;
  throw notPayableError(current.status);
}
