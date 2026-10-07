// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { notificationMoney } from './notification-values.js';
import { costIncludesTax } from './price-display.js';

/** An ended session as the session.Completed and session.Receipt notifications describe it. */
export interface SessionReceiptInput {
  siteName: string | null;
  /** The station's OCPP identity. */
  stationId: string;
  transactionId: string;
  energyDeliveredWh: number;
  finalCostCents: number | null;
  currency: string;
  tariffTaxRate: string | null;
  startedAt: string | Date;
  endedAt: string | Date;
  /** The hold was released because the cost is below the provider minimum charge. */
  notCharged: boolean;
}

/**
 * The template variables of session.Completed and session.Receipt: the OCPP
 * settlement sends them when a session ends, and the operator re-bill of a
 * session the CSMS gave up ending sends session.Receipt with them.
 */
export function sessionReceiptVariables(input: SessionReceiptInput): Record<string, unknown> {
  const startedAt = new Date(input.startedAt);
  const endedAt = new Date(input.endedAt);
  return {
    siteName: input.siteName ?? '',
    stationId: input.stationId,
    transactionId: input.transactionId,
    energyDeliveredWh: input.energyDeliveredWh,
    finalCostCents: input.finalCostCents,
    costFormatted: notificationMoney(input.finalCostCents ?? 0, input.currency),
    costIncludesTax: costIncludesTax(input.finalCostCents, input.tariffTaxRate),
    currency: input.currency,
    durationMinutes: Math.round((endedAt.getTime() - startedAt.getTime()) / 60000),
    startedAt: input.startedAt,
    endedAt: input.endedAt,
    notCharged: input.notCharged,
  };
}
