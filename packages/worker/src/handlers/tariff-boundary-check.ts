// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { eq, and, isNull, sql } from 'drizzle-orm';
import {
  db,
  chargingSessions,
  chargingStations,
  sessionTariffSegments,
  isSplitBillingEnabled,
  isPushDisplayEnabled,
} from '@evtivity/database';
import type { Logger } from 'pino';
import crypto from 'node:crypto';
import { getPubSub } from '@evtivity/api/src/lib/pubsub.js';
import { resolveTariff } from '@evtivity/api/src/services/tariff.service.js';
import { pushPricingDisplayToAllStations } from '@evtivity/api/src/services/pricing-display.service.js';

export async function tariffBoundaryCheckHandler(log: Logger): Promise<void> {
  const [splitBilling, pushDisplay] = await Promise.all([
    isSplitBillingEnabled(),
    isPushDisplayEnabled(),
  ]);

  if (!splitBilling && !pushDisplay) return;

  if (splitBilling) {
    const now = new Date();

    const activeSessions = await db
      .select({
        sessionId: chargingSessions.id,
        stationUuid: chargingSessions.stationId,
        driverId: chargingSessions.driverId,
        tariffId: chargingSessions.tariffId,
        energyDeliveredWh: chargingSessions.energyDeliveredWh,
        idleMinutes: chargingSessions.idleMinutes,
        currentCostCents: chargingSessions.currentCostCents,
        stationOcppId: chargingStations.stationId,
        ocppProtocol: chargingStations.ocppProtocol,
      })
      .from(chargingSessions)
      .innerJoin(chargingStations, eq(chargingSessions.stationId, chargingStations.id))
      .where(eq(chargingSessions.status, 'active'));

    const pubsub = getPubSub();

    for (const session of activeSessions) {
      try {
        const currentTariff = await resolveTariff(session.stationUuid, session.driverId);
        if (currentTariff == null || currentTariff.id === session.tariffId) continue;

        const energyWh = session.energyDeliveredWh != null ? Number(session.energyDeliveredWh) : 0;
        const idleMins = Number(session.idleMinutes);

        // Close open segment
        await db
          .update(sessionTariffSegments)
          .set({
            endedAt: now,
            energyWhEnd: String(energyWh),
            durationMinutes: sql`EXTRACT(EPOCH FROM (NOW() - started_at)) / 60`,
            idleMinutes: String(idleMins),
          })
          .where(
            and(
              eq(sessionTariffSegments.sessionId, session.sessionId),
              isNull(sessionTariffSegments.endedAt),
            ),
          );

        // Open new segment
        await db.insert(sessionTariffSegments).values({
          sessionId: session.sessionId,
          tariffId: currentTariff.id,
          startedAt: now,
          energyWhStart: String(energyWh),
        });

        // Update session tariff snapshot
        await db
          .update(chargingSessions)
          .set({
            tariffId: currentTariff.id,
            tariffPricePerKwh: currentTariff.pricePerKwh,
            tariffPricePerMinute: currentTariff.pricePerMinute,
            tariffPricePerSession: currentTariff.pricePerSession,
            tariffIdleFeePricePerMinute: currentTariff.idleFeePricePerMinute,
            tariffTaxRate: currentTariff.taxRate,
            updatedAt: sql`now()`,
          })
          .where(eq(chargingSessions.id, session.sessionId));

        log.info(
          {
            sessionId: session.sessionId,
            oldTariffId: session.tariffId,
            newTariffId: currentTariff.id,
          },
          'Tariff boundary: split session at new tariff',
        );

        // Notify OCPP 2.1 stations of cost update (fire-and-forget)
        if (session.ocppProtocol != null && session.ocppProtocol.startsWith('ocpp2')) {
          const commandId = crypto.randomUUID();
          await pubsub.publish(
            'ocpp_commands',
            JSON.stringify({
              commandId,
              stationId: session.stationOcppId,
              action: 'CostUpdated',
              payload: {
                totalCost: (session.currentCostCents ?? 0) / 100,
                transactionId: session.sessionId,
              },
              version: session.ocppProtocol,
            }),
          );
        }
      } catch (err: unknown) {
        log.error(
          { sessionId: session.sessionId, error: err },
          'Tariff boundary check failed for session',
        );
      }
    }
  }

  if (pushDisplay) {
    await pushPricingDisplayToAllStations(log);
  }
}
