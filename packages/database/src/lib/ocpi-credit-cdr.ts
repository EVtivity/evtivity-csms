// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

// The only writer of credit CDRs, used by the API (operator credit) and the
// OCPI server. OCPI 2.2.1 and 2.3.0 §10.1.1 (Credit CDRs): the credit CDR has
// a new id, credit = true, credit_reference_id = the original CDR id, and
// "will contain all the data of the original CDR. Only the values in the
// total_cost field SHALL contain the negative amounts of the original CDR."

import crypto from 'node:crypto';
import { eq, and, isNotNull, isNull, sql } from 'drizzle-orm';
import { db } from '../config.js';
import { ocpiCdrs, ocpiRoamingSessions } from '../schema/ocpi.js';

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
  | {
      status: 'created';
      cdrId: string;
      cdrData: Record<string, unknown>;
      /** The charging session of the credited CDR (for its audit row). */
      chargingSessionId: string;
      partnerId: string;
    }
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
    // last_updated and created_at are one instant (the CDRs sender filters
    // and orders on created_at).
    const now = new Date();
    const cdrData = creditCdrData(
      original.cdrData as Record<string, unknown>,
      originalCdrId,
      creditCdrId,
      reason,
      now,
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
      createdAt: now,
      updatedAt: now,
    });
    return {
      status: 'created',
      cdrId: creditCdrId,
      cdrData,
      // Non-null: the original was selected with isNotNull(chargingSessionId).
      chargingSessionId: original.chargingSessionId ?? '',
      partnerId: original.partnerId,
    };
  });
}

export type ReissueCdrResult =
  | {
      status: 'reissued';
      chargingSessionId: string;
      partnerId: string;
      /** The session's superseded CDRs, counted after this reissue (the CDR job's generation). */
      generation: number;
      supersededCdrIds: string[];
    }
  /** Every CDR was superseded already and the new one is not issued yet (a repeat). */
  | { status: 'pending'; chargingSessionId: string; generation: number }
  | { status: 'not_found' }
  /** A live CDR of the session has no credit CDR: credit it first (OCPI 10.1). */
  | { status: 'not_credited'; cdrId: string };

/**
 * Asks for a new CDR of the session of one of our CDRs, after an operator
 * credited it (OCPI 10.1: a sent CDR is never changed; a wrong one is
 * credited and a new one is sent). Every live CDR of the session must have a
 * credit CDR; they are marked superseded, and the OCPI server issues the new
 * CDR (`issueSessionCdr` finds no live CDR) on the job the caller asks for.
 * Runs under the same row lock as the CDR issue (the session's
 * `ocpi_roaming_sessions` row), so a reissue and an issue never interleave,
 * and a repeated reissue before the new CDR exists changes nothing.
 */
export async function supersedeCreditedSessionCdrs(cdrId: string): Promise<ReissueCdrResult> {
  return db.transaction(async (tx): Promise<ReissueCdrResult> => {
    const [cdr] = await tx
      .select({ chargingSessionId: ocpiCdrs.chargingSessionId, partnerId: ocpiCdrs.partnerId })
      .from(ocpiCdrs)
      .where(and(eq(ocpiCdrs.ocpiCdrId, cdrId), isNotNull(ocpiCdrs.chargingSessionId)))
      .limit(1);
    const chargingSessionId = cdr?.chargingSessionId;
    if (cdr == null || chargingSessionId == null) return { status: 'not_found' };

    await tx
      .select({ id: ocpiRoamingSessions.id })
      .from(ocpiRoamingSessions)
      .where(eq(ocpiRoamingSessions.chargingSessionId, chargingSessionId))
      .for('update');

    const live = await tx
      .select({ id: ocpiCdrs.id, ocpiCdrId: ocpiCdrs.ocpiCdrId })
      .from(ocpiCdrs)
      .where(
        and(
          eq(ocpiCdrs.chargingSessionId, chargingSessionId),
          eq(ocpiCdrs.isCredit, false),
          isNull(ocpiCdrs.supersededAt),
        ),
      );
    const superseded = async (): Promise<number> => {
      const [row] = await tx
        .select({ count: sql<number>`count(*)::int` })
        .from(ocpiCdrs)
        .where(
          and(
            eq(ocpiCdrs.chargingSessionId, chargingSessionId),
            eq(ocpiCdrs.isCredit, false),
            isNotNull(ocpiCdrs.supersededAt),
          ),
        );
      return row?.count ?? 0;
    };
    if (live.length === 0) {
      return { status: 'pending', chargingSessionId, generation: await superseded() };
    }

    for (const row of live) {
      const [credit] = await tx
        .select({ id: ocpiCdrs.id })
        .from(ocpiCdrs)
        .where(
          and(
            eq(ocpiCdrs.chargingSessionId, chargingSessionId),
            eq(ocpiCdrs.isCredit, true),
            sql`${ocpiCdrs.cdrData}->>'credit_reference_id' = ${row.ocpiCdrId}`,
          ),
        )
        .limit(1);
      if (credit == null) return { status: 'not_credited', cdrId: row.ocpiCdrId };
    }

    const now = new Date();
    for (const row of live) {
      await tx
        .update(ocpiCdrs)
        .set({ supersededAt: now, updatedAt: now })
        .where(eq(ocpiCdrs.id, row.id));
    }
    return {
      status: 'reissued',
      chargingSessionId,
      partnerId: cdr.partnerId,
      generation: await superseded(),
      supersededCdrIds: live.map((r) => r.ocpiCdrId),
    };
  });
}

export type RetryCdrPushResult =
  | { status: 'claimed'; chargingSessionId: string; partnerId: string; retry: string }
  | { status: 'not_found' }
  /** Only a failed push can be retried. */
  | { status: 'not_failed'; pushStatus: string };

/**
 * Moves a failed CDR of ours back to pending so the OCPI server pushes it
 * again. A compare-and-set on `failed`, so of two clicks only one wins (one
 * push job); `retry` (the time of the claim) makes the job id of this retry.
 */
export async function claimCdrPushRetry(cdrId: string): Promise<RetryCdrPushResult> {
  const now = new Date();
  const [claimed] = await db
    .update(ocpiCdrs)
    .set({ pushStatus: 'pending', updatedAt: now })
    .where(
      and(
        eq(ocpiCdrs.ocpiCdrId, cdrId),
        isNotNull(ocpiCdrs.chargingSessionId),
        eq(ocpiCdrs.pushStatus, 'failed'),
      ),
    )
    .returning({ chargingSessionId: ocpiCdrs.chargingSessionId, partnerId: ocpiCdrs.partnerId });
  if (claimed?.chargingSessionId != null) {
    return {
      status: 'claimed',
      chargingSessionId: claimed.chargingSessionId,
      partnerId: claimed.partnerId,
      retry: String(now.getTime()),
    };
  }
  const [row] = await db
    .select({ pushStatus: ocpiCdrs.pushStatus })
    .from(ocpiCdrs)
    .where(and(eq(ocpiCdrs.ocpiCdrId, cdrId), isNotNull(ocpiCdrs.chargingSessionId)))
    .limit(1);
  if (row == null) return { status: 'not_found' };
  return { status: 'not_failed', pushStatus: row.pushStatus };
}
