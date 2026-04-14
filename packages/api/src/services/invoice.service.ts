// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { eq, and, sql, isNull, between } from 'drizzle-orm';
import {
  db,
  invoices,
  invoiceLineItems,
  chargingSessions,
  tariffs,
  sessionTariffSegments,
} from '@evtivity/database';
import { calculateSessionCost, calculateSplitSessionCost } from '@evtivity/lib';
import type { CostBreakdown, TariffInput, TariffSegment } from '@evtivity/lib';
import { getIdlingGracePeriodMinutes } from '@evtivity/database';

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

export interface InvoiceWithLineItems {
  invoice: typeof invoices.$inferSelect;
  lineItems: Array<typeof invoiceLineItems.$inferSelect>;
}

export async function createSessionInvoice(sessionId: string): Promise<InvoiceWithLineItems> {
  const [session] = await db
    .select({
      id: chargingSessions.id,
      driverId: chargingSessions.driverId,
      tariffId: chargingSessions.tariffId,
      energyDeliveredWh: chargingSessions.energyDeliveredWh,
      startedAt: chargingSessions.startedAt,
      endedAt: chargingSessions.endedAt,
      finalCostCents: chargingSessions.finalCostCents,
      currency: chargingSessions.currency,
      status: chargingSessions.status,
      idleMinutes: chargingSessions.idleMinutes,
      tariffPricePerKwh: chargingSessions.tariffPricePerKwh,
      tariffPricePerMinute: chargingSessions.tariffPricePerMinute,
      tariffPricePerSession: chargingSessions.tariffPricePerSession,
      tariffIdleFeePricePerMinute: chargingSessions.tariffIdleFeePricePerMinute,
      tariffTaxRate: chargingSessions.tariffTaxRate,
    })
    .from(chargingSessions)
    .where(eq(chargingSessions.id, sessionId));

  if (session == null) {
    throw new Error('Session not found');
  }

  if (session.status !== 'completed') {
    throw new Error('Session is not completed');
  }

  // Use session.finalCostCents as the authoritative total
  const totalCents = session.finalCostCents ?? 0;
  const currency = session.currency ?? 'USD';

  // Load tariff segments to check for split-billing
  const segments = await db
    .select({
      startedAt: sessionTariffSegments.startedAt,
      endedAt: sessionTariffSegments.endedAt,
      energyWhStart: sessionTariffSegments.energyWhStart,
      energyWhEnd: sessionTariffSegments.energyWhEnd,
      idleMinutes: sessionTariffSegments.idleMinutes,
      tariffId: sessionTariffSegments.tariffId,
    })
    .from(sessionTariffSegments)
    .where(eq(sessionTariffSegments.sessionId, sessionId));

  // Build line items based on split-billing segments or single tariff
  let costBreakdown: CostBreakdown | null = null;
  const segmentBreakdowns: Array<{ breakdown: CostBreakdown; segmentIndex: number }> = [];

  if (segments.length > 1) {
    // Split-billing: load tariff data for each segment
    const tariffIds = [...new Set(segments.map((s) => s.tariffId))];
    const tariffRows =
      tariffIds.length > 0
        ? await db
            .select()
            .from(tariffs)
            .where(sql`${tariffs.id} IN ${tariffIds}`)
        : [];
    const tariffMap = new Map(tariffRows.map((t) => [t.id, t]));
    const gracePeriod = await getIdlingGracePeriodMinutes();

    // Compute per-segment breakdowns for line items
    const tariffSegments: TariffSegment[] = segments.map((seg, index) => {
      const t = tariffMap.get(seg.tariffId);
      const segStartMs = seg.startedAt.getTime();
      const segEndMs = seg.endedAt != null ? seg.endedAt.getTime() : Date.now();
      return {
        tariff: {
          pricePerKwh: t?.pricePerKwh ?? null,
          pricePerMinute: t?.pricePerMinute ?? null,
          pricePerSession: t?.pricePerSession ?? null,
          idleFeePricePerMinute: t?.idleFeePricePerMinute ?? null,
          reservationFeePerMinute: t?.reservationFeePerMinute ?? null,
          taxRate: t?.taxRate ?? null,
          currency: t?.currency ?? currency,
        },
        durationMinutes: (segEndMs - segStartMs) / 60000,
        energyDeliveredWh: Number(seg.energyWhEnd ?? 0) - Number(seg.energyWhStart),
        idleMinutes: Number(seg.idleMinutes),
        isFirstSegment: index === 0,
      };
    });

    costBreakdown = calculateSplitSessionCost(tariffSegments, gracePeriod);

    // Track per-segment breakdowns for multi-segment line items
    for (const [i, seg] of tariffSegments.entries()) {
      const segTariff = seg.isFirstSegment ? seg.tariff : { ...seg.tariff, pricePerSession: null };
      const bd = calculateSessionCost(
        segTariff,
        seg.energyDeliveredWh,
        seg.durationMinutes,
        seg.idleMinutes,
        i === tariffSegments.length - 1 ? gracePeriod : 0,
      );
      segmentBreakdowns.push({ breakdown: bd, segmentIndex: i });
    }
  } else {
    // Single tariff: recalculate with idle minutes from session
    const energyWh = session.energyDeliveredWh != null ? Number(session.energyDeliveredWh) : 0;
    const startMs = session.startedAt != null ? session.startedAt.getTime() : 0;
    const endMs = session.endedAt != null ? session.endedAt.getTime() : 0;
    const durationMinutes = startMs > 0 && endMs > 0 ? (endMs - startMs) / 60000 : 0;
    const idleMinutes = Number(session.idleMinutes);

    // Use session tariff snapshot or load tariff
    const tariffInput: TariffInput | null =
      session.tariffId != null
        ? {
            pricePerKwh: session.tariffPricePerKwh,
            pricePerMinute: session.tariffPricePerMinute,
            pricePerSession: session.tariffPricePerSession,
            idleFeePricePerMinute: session.tariffIdleFeePricePerMinute,
            reservationFeePerMinute: null,
            taxRate: session.tariffTaxRate,
            currency,
          }
        : null;

    if (tariffInput != null) {
      const gracePeriod = await getIdlingGracePeriodMinutes();
      costBreakdown = calculateSessionCost(
        tariffInput,
        energyWh,
        durationMinutes,
        idleMinutes,
        gracePeriod,
      );
    }
  }

  // Compute invoice header from breakdown or finalCostCents
  const taxRate = session.tariffTaxRate != null ? Number(session.tariffTaxRate) : 0;
  let subtotalCents: number;
  let taxCents: number;

  if (costBreakdown != null) {
    subtotalCents = costBreakdown.subtotalCents;
    taxCents = costBreakdown.taxCents;
  } else if (taxRate > 0) {
    subtotalCents = Math.round(totalCents / (1 + taxRate));
    taxCents = totalCents - subtotalCents;
  } else {
    subtotalCents = totalCents;
    taxCents = 0;
  }

  const now = new Date();
  const dueAt = new Date(now);
  dueAt.setDate(dueAt.getDate() + 30);

  const invoiceNumber = await generateInvoiceNumber();

  const [invoice] = await db
    .insert(invoices)
    .values({
      invoiceNumber,
      driverId: session.driverId,
      status: 'issued',
      issuedAt: now,
      dueAt,
      currency,
      subtotalCents,
      taxCents,
      totalCents,
    })
    .returning();
  if (invoice == null) throw new Error('Failed to create invoice');

  // Build line items
  const lineItemValues: Array<{
    invoiceId: string;
    sessionId: string;
    description: string;
    quantity: string;
    unitPriceCents: number;
    totalCents: number;
    taxCents: number;
  }> = [];

  if (segmentBreakdowns.length > 1) {
    // Multi-segment line items
    for (const { breakdown, segmentIndex } of segmentBreakdowns) {
      const segNum = segmentIndex + 1;
      if (breakdown.energyCostCents > 0) {
        lineItemValues.push({
          invoiceId: invoice.id,
          sessionId,
          description: `Segment ${String(segNum)} energy charge`,
          quantity: '1',
          unitPriceCents: breakdown.energyCostCents,
          totalCents: breakdown.energyCostCents,
          taxCents: 0,
        });
      }
      if (breakdown.timeCostCents > 0) {
        lineItemValues.push({
          invoiceId: invoice.id,
          sessionId,
          description: `Segment ${String(segNum)} time charge`,
          quantity: '1',
          unitPriceCents: breakdown.timeCostCents,
          totalCents: breakdown.timeCostCents,
          taxCents: 0,
        });
      }
      if (breakdown.sessionFeeCents > 0) {
        lineItemValues.push({
          invoiceId: invoice.id,
          sessionId,
          description: 'Session fee',
          quantity: '1',
          unitPriceCents: breakdown.sessionFeeCents,
          totalCents: breakdown.sessionFeeCents,
          taxCents: 0,
        });
      }
      if (breakdown.idleFeeCents > 0) {
        lineItemValues.push({
          invoiceId: invoice.id,
          sessionId,
          description: `Segment ${String(segNum)} idle fee`,
          quantity: '1',
          unitPriceCents: breakdown.idleFeeCents,
          totalCents: breakdown.idleFeeCents,
          taxCents: 0,
        });
      }
    }
    if (taxCents > 0) {
      lineItemValues.push({
        invoiceId: invoice.id,
        sessionId,
        description: 'Tax',
        quantity: '1',
        unitPriceCents: taxCents,
        totalCents: taxCents,
        taxCents,
      });
    }
  } else if (costBreakdown != null) {
    // Single tariff line items
    if (costBreakdown.energyCostCents > 0) {
      lineItemValues.push({
        invoiceId: invoice.id,
        sessionId,
        description: 'Energy charge',
        quantity: '1',
        unitPriceCents: costBreakdown.energyCostCents,
        totalCents: costBreakdown.energyCostCents,
        taxCents: 0,
      });
    }
    if (costBreakdown.timeCostCents > 0) {
      lineItemValues.push({
        invoiceId: invoice.id,
        sessionId,
        description: 'Time charge',
        quantity: '1',
        unitPriceCents: costBreakdown.timeCostCents,
        totalCents: costBreakdown.timeCostCents,
        taxCents: 0,
      });
    }
    if (costBreakdown.sessionFeeCents > 0) {
      lineItemValues.push({
        invoiceId: invoice.id,
        sessionId,
        description: 'Session fee',
        quantity: '1',
        unitPriceCents: costBreakdown.sessionFeeCents,
        totalCents: costBreakdown.sessionFeeCents,
        taxCents: 0,
      });
    }
    if (costBreakdown.idleFeeCents > 0) {
      lineItemValues.push({
        invoiceId: invoice.id,
        sessionId,
        description: 'Idle fee',
        quantity: '1',
        unitPriceCents: costBreakdown.idleFeeCents,
        totalCents: costBreakdown.idleFeeCents,
        taxCents: 0,
      });
    }
    if (costBreakdown.taxCents > 0) {
      lineItemValues.push({
        invoiceId: invoice.id,
        sessionId,
        description: 'Tax',
        quantity: '1',
        unitPriceCents: costBreakdown.taxCents,
        totalCents: costBreakdown.taxCents,
        taxCents: costBreakdown.taxCents,
      });
    }
  } else {
    // No tariff available, create a single line item from final cost
    lineItemValues.push({
      invoiceId: invoice.id,
      sessionId,
      description: 'Charging session',
      quantity: '1',
      unitPriceCents: totalCents,
      totalCents,
      taxCents: 0,
    });
  }

  let createdLineItems: Array<typeof invoiceLineItems.$inferSelect> = [];
  if (lineItemValues.length > 0) {
    createdLineItems = await db.insert(invoiceLineItems).values(lineItemValues).returning();
  }

  return { invoice, lineItems: createdLineItems };
}

export async function createAggregatedInvoice(
  driverId: string,
  startDate: Date,
  endDate: Date,
): Promise<InvoiceWithLineItems> {
  // Find completed sessions for this driver in the date range that have no invoice line items yet
  const sessions = await db
    .select({
      id: chargingSessions.id,
      finalCostCents: chargingSessions.finalCostCents,
      currency: chargingSessions.currency,
      startedAt: chargingSessions.startedAt,
      endedAt: chargingSessions.endedAt,
      energyDeliveredWh: chargingSessions.energyDeliveredWh,
      tariffTaxRate: chargingSessions.tariffTaxRate,
    })
    .from(chargingSessions)
    .leftJoin(invoiceLineItems, eq(chargingSessions.id, invoiceLineItems.sessionId))
    .where(
      and(
        eq(chargingSessions.driverId, driverId),
        eq(chargingSessions.status, 'completed'),
        between(chargingSessions.endedAt, startDate, endDate),
        isNull(invoiceLineItems.id),
      ),
    );

  if (sessions.length === 0) {
    throw new Error('No uninvoiced sessions found for this driver in the given date range');
  }

  const now = new Date();
  const dueAt = new Date(now);
  dueAt.setDate(dueAt.getDate() + 30);

  const invoiceNumber = await generateInvoiceNumber();

  let totalSubtotalCents = 0;
  let totalTaxCents = 0;
  const lineItemValues: Array<{
    invoiceId: string;
    sessionId: string;
    description: string;
    quantity: string;
    unitPriceCents: number;
    totalCents: number;
    taxCents: number;
  }> = [];

  for (const session of sessions) {
    const sessionTotal = session.finalCostCents ?? 0;
    const taxRate = session.tariffTaxRate != null ? Number(session.tariffTaxRate) : 0;

    let sessionSubtotal: number;
    let sessionTax: number;
    if (taxRate > 0) {
      sessionSubtotal = Math.round(sessionTotal / (1 + taxRate));
      sessionTax = sessionTotal - sessionSubtotal;
    } else {
      sessionSubtotal = sessionTotal;
      sessionTax = 0;
    }

    totalSubtotalCents += sessionSubtotal;
    totalTaxCents += sessionTax;

    const energyKwh =
      session.energyDeliveredWh != null
        ? (Number(session.energyDeliveredWh) / 1000).toFixed(2)
        : '0';

    const sessionDate =
      session.endedAt != null
        ? (session.endedAt.toISOString().split('T')[0] ?? 'unknown')
        : 'unknown';

    lineItemValues.push({
      invoiceId: '', // placeholder, set after insert
      sessionId: session.id,
      description: `Charging session ${sessionDate} (${energyKwh} kWh)`,
      quantity: '1',
      unitPriceCents: sessionSubtotal,
      totalCents: sessionSubtotal,
      taxCents: sessionTax,
    });
  }

  const currency = sessions[0]?.currency ?? 'USD';
  const grandTotal = totalSubtotalCents + totalTaxCents;

  const [invoice] = await db
    .insert(invoices)
    .values({
      invoiceNumber,
      driverId,
      status: 'issued',
      issuedAt: now,
      dueAt,
      currency,
      subtotalCents: totalSubtotalCents,
      taxCents: totalTaxCents,
      totalCents: grandTotal,
    })
    .returning();
  if (invoice == null) throw new Error('Failed to create invoice');

  // Set the invoice ID on all line items
  for (const item of lineItemValues) {
    item.invoiceId = invoice.id;
  }

  const createdLineItems = await db.insert(invoiceLineItems).values(lineItemValues).returning();

  return { invoice, lineItems: createdLineItems };
}

export async function getInvoice(invoiceId: string): Promise<InvoiceWithLineItems | null> {
  const [invoice] = await db.select().from(invoices).where(eq(invoices.id, invoiceId));

  if (invoice == null) {
    return null;
  }

  const lineItems = await db
    .select()
    .from(invoiceLineItems)
    .where(eq(invoiceLineItems.invoiceId, invoiceId));

  return { invoice, lineItems };
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
