// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import type postgres from 'postgres';
import {
  claimCardMonthlyLimitNotice,
  getCompanyCurrency,
  isFleetEnabled,
} from '@evtivity/database';
import { notificationMoney } from '@evtivity/lib';
import type { PubSubClient, ServiceLogger } from '@evtivity/lib';
import { dispatchDriverNotification, ALL_TEMPLATES_DIRS } from './notification-dispatcher.js';

export const CARD_MONTHLY_LIMIT_EVENT = 'token.MonthlyLimitReached';

export interface CardLimitNoticeDeps {
  sql: postgres.Sql;
  logger: ServiceLogger;
  pubsub?: PubSubClient | undefined;
}

/**
 * Tells the member holding a fleet RFID card that the card reached its
 * monthly spending limit, once per card, month and limit (the claim decides).
 * An unassigned card notifies nobody, and nothing goes while Fleets is off. Fail-open: a failure is logged and the
 * refusal or stop it follows stands.
 */
export async function sendCardMonthlyLimitNotice(
  deps: CardLimitNoticeDeps,
  tokenId: string,
  stationId: string,
): Promise<void> {
  const { sql, logger, pubsub } = deps;
  try {
    // Fleets off: no notice, and the month's claim stays for when it is on again.
    if (!(await isFleetEnabled({ failClosed: true }))) return;
    const target = await claimCardMonthlyLimitNotice(sql, tokenId);
    if (target == null) return;
    const currency = await getCompanyCurrency();
    await dispatchDriverNotification(
      sql,
      CARD_MONTHLY_LIMIT_EVENT,
      target.driverId,
      {
        idToken: target.idToken,
        tokenType: target.tokenType,
        label: target.label ?? '',
        fleetName: target.fleetName,
        limitFormatted: notificationMoney(target.limitCents, currency),
        currency,
        stationId,
      },
      ALL_TEMPLATES_DIRS,
      pubsub,
    );
  } catch (err) {
    logger.warn({ err, tokenId, stationId }, 'RFID card monthly limit notice failed; continuing');
  }
}

/** The notice for the card of a session the monthly limit stopped. */
export async function sendSessionCardMonthlyLimitNotice(
  deps: CardLimitNoticeDeps,
  sessionId: string,
  stationId: string,
): Promise<void> {
  try {
    const [row] = await deps.sql<Array<{ token_id: string | null }>>`
      SELECT token_id FROM charging_sessions WHERE id = ${sessionId}
    `;
    if (row?.token_id == null) return;
    await sendCardMonthlyLimitNotice(deps, row.token_id, stationId);
  } catch (err) {
    deps.logger.warn(
      { err, sessionId, stationId },
      'RFID card monthly limit notice failed; continuing',
    );
  }
}
