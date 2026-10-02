// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { and, eq, inArray } from 'drizzle-orm';
import { db, guestSessions } from '@evtivity/database';
import type { TransactionLimitType } from '../generated/v2_1/types/common/TransactionLimitType.js';

/**
 * Transaction limit of an ad hoc payment (OCPP 2.1 C24 payment terminal, C25
 * QR code web payment). The CSMS started the transaction with the payment's
 * idToken, so the TransactionEventResponse for eventType Started returns the
 * limit stored with the payment (C24.FR.02, C25.FR.24). Returns null when the
 * idToken is not an open ad hoc payment at this station or it has no limit.
 */
export async function findAdHocTransactionLimit(
  stationId: string,
  idToken: string,
): Promise<TransactionLimitType | null> {
  const [payment] = await db
    .select({
      maxCostCents: guestSessions.maxCostCents,
      maxEnergyWh: guestSessions.maxEnergyWh,
      maxTimeSeconds: guestSessions.maxTimeSeconds,
    })
    .from(guestSessions)
    .where(
      and(
        eq(guestSessions.sessionToken, idToken),
        eq(guestSessions.stationOcppId, stationId),
        inArray(guestSessions.status, ['payment_authorized', 'charging']),
      ),
    );
  if (payment == null) return null;

  const limit: TransactionLimitType = {
    ...(payment.maxCostCents != null ? { maxCost: payment.maxCostCents / 100 } : {}),
    ...(payment.maxEnergyWh != null ? { maxEnergy: payment.maxEnergyWh } : {}),
    ...(payment.maxTimeSeconds != null ? { maxTime: payment.maxTimeSeconds } : {}),
  };
  return Object.keys(limit).length > 0 ? limit : null;
}
