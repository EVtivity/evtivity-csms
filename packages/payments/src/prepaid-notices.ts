// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { eq } from 'drizzle-orm';
import {
  client,
  db,
  driverTokens,
  getCompanyCurrency,
  getPrepaidLowCreditThresholdCents,
} from '@evtivity/database';
import { dispatchDriverNotification, notificationMoney } from '@evtivity/lib';
import type { PubSubClient } from '@evtivity/lib';
import type { PrepaidSettlement } from './payment-records.js';

export const PREPAID_LOW_CREDIT_EVENT = 'prepaid.LowCredit';

export interface PrepaidNoticeDeps {
  /** Notification template directories of the calling process. */
  templatesDirs: string[];
  /** The process's pub/sub client, for the portal notification drawer. */
  pubsub: PubSubClient | null;
}

/**
 * True when this debit took the balance from at or above the threshold to
 * below it. A threshold of 0 turns the notice off. A balance that was already
 * below the threshold does not notify again, so each crossing notifies once.
 */
export function crossedLowCreditThreshold(
  settlement: Pick<PrepaidSettlement, 'debitedCents' | 'balanceCents'>,
  thresholdCents: number,
): boolean {
  if (thresholdCents <= 0) return false;
  const before = settlement.balanceCents + settlement.debitedCents;
  return before >= thresholdCents && settlement.balanceCents < thresholdCents;
}

/**
 * Tells the token's driver that the prepaid balance dropped below the
 * `prepaid.lowCreditThresholdCents` setting (`prepaid.LowCredit`). Called once
 * per debit: by the OCPP settlement (a `once` step) and the session re-bill,
 * never for a repeated settlement (`settlement.repeated`), which reports a
 * debit already notified. A token without a driver notifies nobody. Errors
 * propagate; callers log them at warn (P9).
 */
export async function dispatchPrepaidLowCreditNotice(
  settlement: PrepaidSettlement,
  deps: PrepaidNoticeDeps,
): Promise<boolean> {
  if (settlement.repeated === true) return false;
  const thresholdCents = await getPrepaidLowCreditThresholdCents();
  if (!crossedLowCreditThreshold(settlement, thresholdCents)) return false;

  const [token] = await db
    .select({ driverId: driverTokens.driverId, idToken: driverTokens.idToken })
    .from(driverTokens)
    .where(eq(driverTokens.id, settlement.tokenId));
  if (token?.driverId == null) return false;

  // The balance is held in the company currency (settlePrepaidSession debits
  // only sessions billed in it).
  const currency = await getCompanyCurrency();
  await dispatchDriverNotification(
    client,
    PREPAID_LOW_CREDIT_EVENT,
    token.driverId,
    {
      idToken: token.idToken,
      balanceCents: settlement.balanceCents,
      balanceFormatted: notificationMoney(settlement.balanceCents, currency),
      thresholdFormatted: notificationMoney(thresholdCents, currency),
      currency,
    },
    deps.templatesDirs,
    deps.pubsub ?? undefined,
  );
  return true;
}
