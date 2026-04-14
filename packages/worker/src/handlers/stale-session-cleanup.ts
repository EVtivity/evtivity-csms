// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import crypto from 'node:crypto';
import { eq, and, sql, lte } from 'drizzle-orm';
import {
  db,
  chargingSessions,
  chargingStations,
  getStaleSessionTimeoutHours,
  getIdlingGracePeriodMinutes,
  isSplitBillingEnabled,
} from '@evtivity/database';
import { calculateSessionCost, calculateSplitSessionCost } from '@evtivity/lib';
import type { TariffSegment } from '@evtivity/lib';
import type { Logger } from 'pino';
import { getPubSub } from '@evtivity/api/src/lib/pubsub.js';

export async function staleSessionCleanupHandler(log: Logger): Promise<void> {
  const timeoutHours = await getStaleSessionTimeoutHours();
  if (timeoutHours <= 0) {
    log.debug('Stale session cleanup disabled (timeout <= 0)');
    return;
  }

  const cutoff = new Date(Date.now() - timeoutHours * 60 * 60 * 1000);

  // Find active sessions not updated since the cutoff
  const staleSessions = await db
    .select({
      id: chargingSessions.id,
      stationId: chargingSessions.stationId,
      driverId: chargingSessions.driverId,
      transactionId: chargingSessions.transactionId,
      startedAt: chargingSessions.startedAt,
      updatedAt: chargingSessions.updatedAt,
      energyDeliveredWh: chargingSessions.energyDeliveredWh,
      currentCostCents: chargingSessions.currentCostCents,
      currency: chargingSessions.currency,
      tariffId: chargingSessions.tariffId,
      tariffPricePerKwh: chargingSessions.tariffPricePerKwh,
      tariffPricePerMinute: chargingSessions.tariffPricePerMinute,
      tariffPricePerSession: chargingSessions.tariffPricePerSession,
      tariffIdleFeePricePerMinute: chargingSessions.tariffIdleFeePricePerMinute,
      tariffTaxRate: chargingSessions.tariffTaxRate,
      idleStartedAt: chargingSessions.idleStartedAt,
      idleMinutes: chargingSessions.idleMinutes,
      stationIsOnline: chargingStations.isOnline,
      stationOcppId: chargingStations.stationId,
      ocppProtocol: chargingStations.ocppProtocol,
    })
    .from(chargingSessions)
    .innerJoin(chargingStations, eq(chargingSessions.stationId, chargingStations.id))
    .where(and(eq(chargingSessions.status, 'active'), lte(chargingSessions.updatedAt, cutoff)));

  if (staleSessions.length === 0) {
    return;
  }

  log.info({ count: staleSessions.length, timeoutHours }, 'Found stale sessions to clean up');

  const gracePeriod = await getIdlingGracePeriodMinutes();
  const splitEnabled = await isSplitBillingEnabled();

  for (const session of staleSessions) {
    try {
      // Use the last updated_at as the session end time
      const endedAt = session.updatedAt;
      const energyWh = Number(session.energyDeliveredWh ?? 0);

      // Calculate final cost if tariff snapshot exists
      let finalCostCents = session.currentCostCents;

      if (session.tariffId != null && session.currency != null && session.startedAt != null) {
        // Calculate idle minutes
        const accumulatedIdle = Number(session.idleMinutes);
        const idleMinutes =
          session.idleStartedAt != null
            ? accumulatedIdle + (endedAt.getTime() - session.idleStartedAt.getTime()) / 60000
            : accumulatedIdle;

        // Close any open tariff segment
        const endedAtIso = endedAt.toISOString();
        await db.execute(sql`
          UPDATE session_tariff_segments
          SET ended_at = ${endedAtIso},
              energy_wh_end = ${energyWh},
              duration_minutes = EXTRACT(EPOCH FROM (${endedAtIso}::timestamptz - started_at)) / 60,
              idle_minutes = ${idleMinutes}
          WHERE session_id = ${session.id} AND ended_at IS NULL
        `);

        // Check for split billing segments
        let computed = false;
        if (splitEnabled) {
          const segments = await db.execute(sql`
            SELECT sts.started_at, sts.ended_at, sts.energy_wh_start, sts.energy_wh_end,
                   sts.idle_minutes AS seg_idle_minutes,
                   t.currency, t.price_per_kwh, t.price_per_minute, t.price_per_session,
                   t.idle_fee_price_per_minute, t.tax_rate
            FROM session_tariff_segments sts
            JOIN tariffs t ON t.id = sts.tariff_id
            WHERE sts.session_id = ${session.id}
            ORDER BY sts.started_at
          `);

          if (segments.length > 1) {
            const tariffSegments: TariffSegment[] = segments.map(
              (seg: Record<string, unknown>, index: number) => {
                const segStart = new Date(seg.started_at as string).getTime();
                const segEnd = new Date(seg.ended_at as string).getTime();
                return {
                  tariff: {
                    pricePerKwh: seg.price_per_kwh as string | null,
                    pricePerMinute: seg.price_per_minute as string | null,
                    pricePerSession: seg.price_per_session as string | null,
                    idleFeePricePerMinute: seg.idle_fee_price_per_minute as string | null,
                    reservationFeePerMinute: null,
                    taxRate: seg.tax_rate as string | null,
                    currency: seg.currency as string,
                  },
                  durationMinutes: (segEnd - segStart) / 60000,
                  energyDeliveredWh:
                    Number(seg.energy_wh_end ?? 0) - Number(seg.energy_wh_start ?? 0),
                  idleMinutes: Number(seg.seg_idle_minutes ?? 0),
                  isFirstSegment: index === 0,
                };
              },
            );
            finalCostCents = calculateSplitSessionCost(tariffSegments, gracePeriod).totalCents;
            computed = true;
          }
        }

        if (!computed) {
          const durationMinutes = (endedAt.getTime() - session.startedAt.getTime()) / 60000;
          const accIdle = Number(session.idleMinutes);
          const totalIdle =
            session.idleStartedAt != null
              ? accIdle + (endedAt.getTime() - session.idleStartedAt.getTime()) / 60000
              : accIdle;

          finalCostCents = calculateSessionCost(
            {
              pricePerKwh: session.tariffPricePerKwh,
              pricePerMinute: session.tariffPricePerMinute,
              pricePerSession: session.tariffPricePerSession,
              idleFeePricePerMinute: session.tariffIdleFeePricePerMinute,
              reservationFeePerMinute: null,
              taxRate: session.tariffTaxRate,
              currency: session.currency,
            },
            energyWh,
            durationMinutes,
            totalIdle,
            gracePeriod,
          ).totalCents;
        }
      }

      // Mark session as faulted
      await db
        .update(chargingSessions)
        .set({
          status: 'faulted',
          stoppedReason: 'StaleSession',
          endedAt,
          finalCostCents: finalCostCents ?? session.currentCostCents,
          currentCostCents: finalCostCents ?? session.currentCostCents,
          updatedAt: new Date(),
        })
        .where(eq(chargingSessions.id, session.id));

      // Send RequestStopTransaction to online stations to clear the station-side transaction
      if (session.stationIsOnline) {
        try {
          const commandId = crypto.randomUUID();
          const pubsub = getPubSub();
          const notification = JSON.stringify({
            commandId,
            stationId: session.stationOcppId,
            action: 'RequestStopTransaction',
            payload: { transactionId: session.transactionId },
            ...(session.ocppProtocol != null ? { version: session.ocppProtocol } : {}),
          });
          await pubsub.publish('ocpp_commands', notification);
          log.info(
            { sessionId: session.id, transactionId: session.transactionId },
            'Sent RequestStopTransaction for stale session on online station',
          );
        } catch (stopErr: unknown) {
          log.warn(
            { sessionId: session.id, error: stopErr },
            'Failed to send RequestStopTransaction for stale session',
          );
        }
      }

      log.info(
        {
          sessionId: session.id,
          stationId: session.stationId,
          transactionId: session.transactionId,
          stationOnline: session.stationIsOnline,
          lastUpdate: session.updatedAt.toISOString(),
          finalCostCents,
        },
        'Closed stale session',
      );
    } catch (err: unknown) {
      log.error({ sessionId: session.id, error: err }, 'Failed to close stale session');
    }
  }

  log.info({ count: staleSessions.length }, 'Stale session cleanup complete');
}
