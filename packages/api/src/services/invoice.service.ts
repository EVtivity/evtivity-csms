// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { eq, and, sql, isNull, isNotNull, between, asc, ne, inArray } from 'drizzle-orm';
import {
  db,
  invoices,
  invoiceLineItems,
  chargingSessions,
  drivers,
  paymentRecords,
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
} from '@evtivity/lib';
import type {
  CostDimension,
  CostTaxLine,
  SessionCostBreakdown,
  TaxBasis,
  TaxLine,
  TaxBreakdownLine,
} from '@evtivity/lib';
import { getCompanyCurrency } from '@evtivity/database';
import { storedCostBreakdown } from '../lib/session-tax.js';
import { inCompanyCurrency, sessionCurrencySql } from '../lib/company-currency.js';

const logger = createLogger('invoice-service');

/**
 * Generate a unique invoice number using a PostgreSQL SEQUENCE.
 * Format: INV-YYYYMM-NNNN (e.g., INV-202603-0042).
 * The sequence guarantees uniqueness under concurrent access without retries.
 */
export async function generateInvoiceNumber(): Promise<string> {
  const now = new Date();
  const year = now.getFullYear();
  const month = String(now.getMonth() + 1).padStart(2, '0');
  const prefix = `INV-${String(year)}${month}-`;

  const [row] = await db.execute(sql`SELECT nextval('invoice_number_seq') AS seq`);
  const seq = Number((row as { seq: string }).seq);
  return `${prefix}${String(seq).padStart(4, '0')}`;
}

export interface InvoiceDriver {
  id: string;
  firstName: string;
  lastName: string;
  email: string | null;
  /** The driver's preferred language; the invoice PDF renders in it. */
  language: string;
}

export interface InvoiceWithLineItems {
  invoice: typeof invoices.$inferSelect;
  lineItems: Array<typeof invoiceLineItems.$inferSelect>;
}

export interface InvoiceDetail extends InvoiceWithLineItems {
  driver: InvoiceDriver | null;
  /** Net amount, tax rate, tax amount, and gross per rate, from the line items. */
  taxBreakdown: TaxBreakdownLine[];
}

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
}

interface LineDraft {
  sessionId: string | null;
  /** The reservation fee payment record a fee line invoices. */
  paymentRecordId?: number | null;
  description: string;
  metadata: InvoiceLineMetadata;
  taxRate: number;
  netCents: number;
  taxCents: number;
}

interface SessionForInvoice {
  id: string;
  driverId: string | null;
  energyDeliveredWh: string | null;
  endedAt: Date | null;
  finalCostCents: number;
  tariffTaxRate: string | null;
  costBreakdown: unknown;
}

const sessionColumns = {
  id: chargingSessions.id,
  driverId: chargingSessions.driverId,
  energyDeliveredWh: chargingSessions.energyDeliveredWh,
  endedAt: chargingSessions.endedAt,
  tariffTaxRate: chargingSessions.tariffTaxRate,
  costBreakdown: chargingSessions.costBreakdown,
};

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
function sessionCostBreakdown(session: SessionForInvoice): SessionCostBreakdown {
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
function sessionSummaryLines(session: SessionForInvoice, taxLines: TaxLine[]): LineDraft[] {
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

/**
 * Insert an invoice and its lines in one transaction. The header holds the
 * sum of the lines; it must equal the amount the driver was charged.
 */
async function insertInvoice(
  driverId: string | null,
  currency: string,
  lines: LineDraft[],
  chargedCents: number,
): Promise<InvoiceWithLineItems> {
  const totals = taxTotals(lines);
  if (totals.grossCents !== chargedCents) {
    throw new Error(
      `Invoice lines total ${String(totals.grossCents)} but the sessions were charged ${String(chargedCents)}`,
    );
  }

  const now = new Date();
  const dueAt = new Date(now);
  dueAt.setDate(dueAt.getDate() + 30);
  const invoiceNumber = await generateInvoiceNumber();

  return db.transaction(async (tx) => {
    const [invoice] = await tx
      .insert(invoices)
      .values({
        invoiceNumber,
        driverId,
        status: 'issued',
        issuedAt: now,
        dueAt,
        currency,
        subtotalCents: totals.netCents,
        taxCents: totals.taxCents,
        totalCents: totals.grossCents,
      })
      .returning();
    if (invoice == null) throw new Error('Failed to create invoice');

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
  });
}

export async function createSessionInvoice(sessionId: string): Promise<InvoiceWithLineItems> {
  const [row] = await db
    .select({
      ...sessionColumns,
      finalCostCents: chargingSessions.finalCostCents,
      currency: sessionCurrencySql(),
      status: chargingSessions.status,
    })
    .from(chargingSessions)
    .where(eq(chargingSessions.id, sessionId));

  if (row == null) {
    throw new Error('Session not found');
  }

  if (row.status !== 'completed') {
    throw new Error('Session is not completed');
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

  const [alreadyInvoiced] = await db
    .select({ id: invoiceLineItems.id })
    .from(invoiceLineItems)
    .where(eq(invoiceLineItems.sessionId, sessionId))
    .limit(1);
  if (alreadyInvoiced != null) {
    throw new Error('Session is already invoiced');
  }

  const session: SessionForInvoice = { ...row, finalCostCents: row.finalCostCents };
  const lines = singleSessionLines(session);
  return insertInvoice(session.driverId, row.currency, lines, session.finalCostCents);
}

export async function createAggregatedInvoice(
  driverId: string,
  startDate: Date,
  endDate: Date,
): Promise<InvoiceWithLineItems> {
  // Sessions billed in another currency stay uninvoiced here; they can still be invoiced one by one.
  const currency = await getCompanyCurrency();
  const rows = await db
    .select({ ...sessionColumns, finalCostCents: chargingSessions.finalCostCents })
    .from(chargingSessions)
    .leftJoin(invoiceLineItems, eq(chargingSessions.id, invoiceLineItems.sessionId))
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
        isNull(invoiceLineItems.id),
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
    .leftJoin(invoiceLineItems, eq(invoiceLineItems.paymentRecordId, paymentRecords.id))
    .where(
      and(
        eq(paymentRecords.driverId, driverId),
        ne(paymentRecords.chargeType, 'session'),
        inArray(paymentRecords.status, ['captured', 'partially_refunded', 'refunded']),
        isNotNull(paymentRecords.capturedAmountCents),
        between(paymentRecords.createdAt, startDate, endDate),
        isNull(invoiceLineItems.id),
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
  let chargedCents = 0;
  for (const row of rows) {
    const session: SessionForInvoice = { ...row, finalCostCents: row.finalCostCents ?? 0 };
    chargedCents += session.finalCostCents;
    lines.push(...sessionSummaryLines(session, sessionCostBreakdown(session).taxLines));
  }
  for (const fee of fees) {
    const gross = fee.capturedAmountCents ?? 0;
    chargedCents += gross;
    lines.push(feeLine(fee.id, fee.chargeType, gross, Number(fee.taxRate ?? 0), fee.createdAt));
  }

  return insertInvoice(driverId, currency, lines, chargedCents);
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

  return { invoice, lineItems, driver, taxBreakdown };
}

export async function voidInvoice(invoiceId: string): Promise<typeof invoices.$inferSelect | null> {
  const [invoice] = await db.select().from(invoices).where(eq(invoices.id, invoiceId));

  if (invoice == null) {
    return null;
  }

  if (invoice.status === 'void') {
    return invoice;
  }

  const [updated] = await db
    .update(invoices)
    .set({ status: 'void', updatedAt: new Date() })
    .where(eq(invoices.id, invoiceId))
    .returning();

  return updated ?? null;
}
