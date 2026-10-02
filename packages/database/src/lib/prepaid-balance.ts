// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { eq, sql } from 'drizzle-orm';
import { db } from '../config.js';
import { chargingSessions } from '../schema/charging.js';
import { driverTokens } from '../schema/drivers.js';
import { paymentRecords } from '../schema/payments.js';
import { tokenAuditLog } from '../schema/audit.js';
import { writeAudit } from './audit.js';
import { getCompanyCurrency } from './system-settings.js';

interface PrepaidLogger {
  warn: (obj: unknown, msg?: string) => void;
}

export interface PrepaidSettlement {
  tokenId: string;
  debitedCents: number;
  balanceCents: number;
}

/**
 * Debits the final cost of an ended session from the prepaid balance of the
 * token that started it (OCPP 2.1 C17). The `payment_records` row (unique per
 * session, `payment_source = 'prepaid'`) is the idempotency marker, so a
 * replayed Ended event never debits twice. The balance may go below zero when
 * the final cost exceeds the remaining credit; the next Authorize then answers
 * NoCredit.
 *
 * Returns null when the session has no prepaid token, no cost, a currency other
 * than the company currency (the balance is held in the company currency), or
 * was already settled.
 */
export async function settlePrepaidSession(
  sessionId: string,
  logger?: PrepaidLogger,
): Promise<PrepaidSettlement | null> {
  const [row] = await db
    .select({
      tokenId: driverTokens.id,
      idToken: driverTokens.idToken,
      tokenType: driverTokens.tokenType,
      tokenDriverId: driverTokens.driverId,
      balanceCents: driverTokens.prepaidBalanceCents,
      driverId: chargingSessions.driverId,
      finalCostCents: chargingSessions.finalCostCents,
      currency: sql<string>`upper(${chargingSessions.currency})`,
    })
    .from(chargingSessions)
    .innerJoin(driverTokens, eq(driverTokens.id, chargingSessions.tokenId))
    .where(eq(chargingSessions.id, sessionId));

  if (row?.balanceCents == null) return null;
  const costCents = row.finalCostCents ?? 0;
  if (costCents <= 0) return null;

  const companyCurrency = await getCompanyCurrency();
  if (row.currency !== companyCurrency) {
    logger?.warn(
      { sessionId, sessionCurrency: row.currency, companyCurrency },
      'Prepaid session billed in another currency than the company currency; balance not debited',
    );
    return null;
  }

  const result = await db.transaction(async (tx) => {
    const inserted = await tx
      .insert(paymentRecords)
      .values({
        sessionId,
        driverId: row.driverId ?? row.tokenDriverId,
        paymentSource: 'prepaid',
        currency: row.currency,
        capturedAmountCents: costCents,
        status: 'captured',
        metadata: { tokenId: row.tokenId },
      })
      .onConflictDoNothing({ target: paymentRecords.sessionId })
      .returning({ id: paymentRecords.id });
    if (inserted.length === 0) return null;

    const [updated] = await tx
      .update(driverTokens)
      .set({
        prepaidBalanceCents: sql`${driverTokens.prepaidBalanceCents} - ${costCents}`,
        updatedAt: new Date(),
      })
      .where(eq(driverTokens.id, row.tokenId))
      .returning({ balanceCents: driverTokens.prepaidBalanceCents });
    if (updated?.balanceCents == null) return null;
    return { before: updated.balanceCents + costCents, after: updated.balanceCents };
  });
  if (result == null) return null;

  await writeAudit(
    { table: tokenAuditLog, idColumn: 'token_id' },
    {
      entityId: row.tokenId,
      entityIdSnapshot: row.tokenId,
      action: 'updated',
      actor: 'system',
      actorLabel: 'prepaid_debit',
      before: { prepaidBalanceCents: result.before },
      after: { prepaidBalanceCents: result.after },
      notes: `Prepaid debit of ${String(costCents)} for session ${sessionId}`,
    },
    db,
    logger,
  );

  return { tokenId: row.tokenId, debitedCents: costCents, balanceCents: result.after };
}
