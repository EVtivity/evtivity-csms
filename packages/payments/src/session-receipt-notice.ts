// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { client } from '@evtivity/database';
import { dispatchDriverNotification, receiptBilling, sessionReceiptVariables } from '@evtivity/lib';
import type { PubSubClient } from '@evtivity/lib';
import { isReleasedBelowMinimum } from './session-payments.js';

export interface SessionReceiptNoticeDeps {
  /** Notification template directories of the calling process. */
  templatesDirs: string[];
  pubsub: PubSubClient | null;
}

/**
 * Sends the driver's session.Receipt once the payment it confirms is final
 * (finding JB-3). The OCPP settlement sends it at session end unless an async
 * provider has not confirmed the capture yet (the record's pending_operation
 * is capture or adjust); the webhook that confirms the capture then calls
 * this. The receipt is due only for an ended session (not active, faulted or
 * failed) of a driver whose first payment record is neither failed (no
 * receipt after a failed capture) nor waiting for a capture or adjustment.
 * The claim (`receipt_notified_at`, set WHERE IS NULL) is the one the
 * settlement takes, so the receipt goes out once whichever path sends it.
 * Returns whether this call claimed and sent it. The dispatch is fail-open
 * in the caller (P9).
 */
export async function dispatchSessionReceiptIfDue(
  sessionId: string,
  deps: SessionReceiptNoticeDeps,
): Promise<boolean> {
  const [claimed] = await client`
    UPDATE charging_sessions cs SET receipt_notified_at = now()
    WHERE cs.id = ${sessionId} AND cs.receipt_notified_at IS NULL
      AND cs.driver_id IS NOT NULL
      AND cs.status NOT IN ('active', 'faulted', 'failed')
      AND NOT EXISTS (
        SELECT 1 FROM (
          SELECT pr.status, pr.pending_operation FROM payment_records pr
          WHERE pr.session_id = cs.id
          ORDER BY pr.id LIMIT 1
        ) first_record
        WHERE first_record.status = 'failed'
          OR first_record.pending_operation IN ('capture', 'adjust')
      )
    RETURNING cs.id`;
  if (claimed == null) return false;
  const [row] = await client`
    SELECT cs.driver_id, cs.transaction_id, cs.energy_delivered_wh, cs.final_cost_cents,
           cs.started_at, cs.ended_at, cs.tariff_tax_rate, UPPER(cs.currency) AS currency,
           cs.billing_mode, f.name AS billing_fleet_name, st.station_id AS station_ocpp_id,
           si.name AS site_name, pr.status AS record_status, pr.failure_reason
    FROM charging_sessions cs
    JOIN charging_stations st ON st.id = cs.station_id
    LEFT JOIN sites si ON si.id = st.site_id
    LEFT JOIN fleets f ON f.id = cs.billing_fleet_id
    LEFT JOIN LATERAL (
      SELECT status, failure_reason FROM payment_records
      WHERE session_id = cs.id ORDER BY id LIMIT 1
    ) pr ON true
    WHERE cs.id = ${sessionId}`;
  if (row == null) return false;
  const hasRecord = row.record_status != null;
  await dispatchDriverNotification(
    client,
    'session.Receipt',
    row.driver_id as string,
    sessionReceiptVariables({
      siteName: (row.site_name as string | null) ?? null,
      stationId: row.station_ocpp_id as string,
      transactionId: (row.transaction_id as string | null) ?? '',
      energyDeliveredWh: Number(row.energy_delivered_wh ?? 0),
      finalCostCents: row.final_cost_cents != null ? Number(row.final_cost_cents) : null,
      currency: row.currency as string,
      tariffTaxRate: row.tariff_tax_rate as string | null,
      startedAt: row.started_at as Date,
      endedAt: (row.ended_at as Date | null) ?? new Date(),
      notCharged:
        hasRecord &&
        isReleasedBelowMinimum({
          status: row.record_status as string,
          failureReason: row.failure_reason as string | null,
        }),
      ...receiptBilling(
        row.billing_mode,
        (row.billing_fleet_name as string | null) ?? null,
        hasRecord,
      ),
    }),
    deps.templatesDirs,
    deps.pubsub ?? undefined,
  );
  return true;
}
