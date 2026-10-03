// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

// The only writer of credit CDRs, used by the API (operator credit) and the
// OCPI server. OCPI 2.2.1 and 2.3.0 §10.1.1 (Credit CDRs): the credit CDR has
// a new id, credit = true, credit_reference_id = the original CDR id, and
// "will contain all the data of the original CDR. Only the values in the
// total_cost field SHALL contain the negative amounts of the original CDR."

import crypto from 'node:crypto';
import { eq, and, isNotNull, sql } from 'drizzle-orm';
import { db } from '../config.js';
import { ocpiCdrs } from '../schema/ocpi.js';

/**
 * An OCPI Price of either version with every amount negated: excl_vat and
 * incl_vat (2.2.1), before_taxes and each tax amount (2.3.0). Null when the
 * value is not a Price.
 */
export function negateOcpiPrice(price: unknown): Record<string, unknown> | null {
  if (price == null || typeof price !== 'object') return null;
  const p = price as Record<string, unknown>;
  if (typeof p['before_taxes'] === 'number') {
    const negated: Record<string, unknown> = { before_taxes: -p['before_taxes'] };
    if (Array.isArray(p['taxes'])) {
      negated['taxes'] = (p['taxes'] as Array<Record<string, unknown>>).map((t) => ({
        ...t,
        amount: typeof t['amount'] === 'number' ? -t['amount'] : t['amount'],
      }));
    }
    return negated;
  }
  if (typeof p['excl_vat'] === 'number') {
    const negated: Record<string, unknown> = { excl_vat: -p['excl_vat'] };
    if (typeof p['incl_vat'] === 'number') negated['incl_vat'] = -p['incl_vat'];
    return negated;
  }
  return null;
}

/** The original CDR as a credit CDR (§10.1.1): only total_cost is negated. */
export function creditCdrData(
  original: Record<string, unknown>,
  originalCdrId: string,
  creditCdrId: string,
  reason: string,
  now: Date,
): Record<string, unknown> | null {
  const totalCost = negateOcpiPrice(original['total_cost']);
  if (totalCost == null) return null;
  return {
    ...original,
    id: creditCdrId,
    credit: true,
    credit_reference_id: originalCdrId,
    remark: reason,
    total_cost: totalCost,
    last_updated: now.toISOString(),
  };
}

export type CreditCdrResult =
  | { status: 'created'; cdrId: string; cdrData: Record<string, unknown> }
  | { status: 'existing'; cdrId: string; cdrData: Record<string, unknown> }
  | { status: 'not_found' }
  | { status: 'is_credit' }
  | { status: 'invalid_cdr' };

/**
 * Stores a credit CDR for one of our CDRs (a CDR we issued as CPO, linked to
 * a charging session; CDRs received from partners are theirs to credit),
 * pending push. Crediting a CDR that
 * already has a credit CDR returns that one (a retry or double submit does not
 * credit the partner twice). The original row is locked so two concurrent
 * credits of the same CDR serialize.
 */
export async function createCreditCdr(
  originalCdrId: string,
  reason: string,
): Promise<CreditCdrResult> {
  return db.transaction(async (tx) => {
    const [original] = await tx
      .select()
      .from(ocpiCdrs)
      .where(and(eq(ocpiCdrs.ocpiCdrId, originalCdrId), isNotNull(ocpiCdrs.chargingSessionId)))
      .limit(1)
      .for('update');
    if (original == null) return { status: 'not_found' };
    if (original.isCredit) return { status: 'is_credit' };

    const [existing] = await tx
      .select({ ocpiCdrId: ocpiCdrs.ocpiCdrId, cdrData: ocpiCdrs.cdrData })
      .from(ocpiCdrs)
      .where(
        and(
          eq(ocpiCdrs.partnerId, original.partnerId),
          eq(ocpiCdrs.isCredit, true),
          sql`${ocpiCdrs.cdrData}->>'credit_reference_id' = ${originalCdrId}`,
        ),
      )
      .limit(1);
    if (existing != null) {
      return {
        status: 'existing',
        cdrId: existing.ocpiCdrId,
        cdrData: existing.cdrData as Record<string, unknown>,
      };
    }

    const creditCdrId = crypto.randomUUID();
    const cdrData = creditCdrData(
      original.cdrData as Record<string, unknown>,
      originalCdrId,
      creditCdrId,
      reason,
      new Date(),
    );
    if (cdrData == null) return { status: 'invalid_cdr' };

    await tx.insert(ocpiCdrs).values({
      partnerId: original.partnerId,
      ocpiCdrId: creditCdrId,
      chargingSessionId: original.chargingSessionId,
      totalEnergy: original.totalEnergy,
      // ocpi_cdrs.total_cost holds the amount excluding tax.
      totalCost: String(-Number(original.totalCost)),
      currency: original.currency,
      cdrData,
      isCredit: true,
      pushStatus: 'pending',
    });
    return { status: 'created', cdrId: creditCdrId, cdrData };
  });
}
