// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { eq, and, isNull, isNotNull, sql } from 'drizzle-orm';
import {
  db,
  chargingSessions,
  chargingStations,
  sessionTariffSegments,
  isSplitBillingEnabled,
  isStationMessageEnabled,
} from '@evtivity/database';
import type { Logger } from 'pino';
import crypto from 'node:crypto';
import { getPubSub } from '@evtivity/api/src/lib/pubsub.js';
import { resolveTariff } from '@evtivity/api/src/services/tariff.service.js';
import { pushAllMessagesToAllStations } from '@evtivity/api/src/services/station-message.service.js';

export async function tariffBoundaryCheckHandler(log: Logger): Promise<void> {
  const [splitBilling, pushDisplay] = await Promise.all([
    isSplitBillingEnabled(),
    isStationMessageEnabled(),
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

    // Per-session body has internal sequencing (resolve tariff -> close
    // segment -> open segment -> snapshot -> publish), but every session is
    // independent of every other. The previous serial loop spent (~5 DB
    // queries) * N sessions of wall time per minute; at N=500 this saturates
    // the worker's DB pool. Batch the sessions and run each batch with
    // Promise.allSettled so one session's failure doesn't stop the cron tick.
    const processSession = async (session: (typeof activeSessions)[number]): Promise<void> => {
      const currentTariff = await resolveTariff(session.stationUuid, session.driverId);
      if (currentTariff == null || currentTariff.id === session.tariffId) return;

      const energyWh = session.energyDeliveredWh != null ? Number(session.energyDeliveredWh) : 0;
      const sessionIdleMins = Number(session.idleMinutes);

      // session.idleMinutes is the WHOLE-session idle accumulator, not a
      // per-segment delta. Subtract whatever was already attributed to
      // closed segments so each segment carries only the idle that occurred
      // inside its own window. Without this, sessions that cross multiple
      // tariff boundaries inflate the per-segment idle column on every
      // additional close (segment 1 holds idle@T1, segment 2 holds idle@T2
      // which already includes segment 1's portion, etc.). The final
      // invoice is unaffected (event-projections.ts overrides per-segment
      // idle to zero except the last segment when it recomputes total
      // cost) but per-segment cost reports and dispute audits would read
      // inflated values from this column.
      const [closedIdleAgg] = await db
        .select({
          total: sql<string>`COALESCE(SUM(${sessionTariffSegments.idleMinutes}), 0)`,
        })
        .from(sessionTariffSegments)
        .where(
          and(
            eq(sessionTariffSegments.sessionId, session.sessionId),
            isNotNull(sessionTariffSegments.endedAt),
          ),
        );
      const closedIdleMins = Number(closedIdleAgg?.total ?? 0);
      const segmentIdleMins = Math.max(0, sessionIdleMins - closedIdleMins);

      // Wrap close-open-snapshot in a transaction so a transient failure
      // (e.g. close succeeds, open fails) doesn't leave the session with no
      // open segment while the tariff snapshot still points at the old
      // tariff. The next cron tick still self-heals via the same path, but
      // the transaction keeps each tick's segments and snapshot consistent.
      await db.transaction(async (tx) => {
        await tx
          .update(sessionTariffSegments)
          .set({
            endedAt: now,
            energyWhEnd: String(energyWh),
            durationMinutes: sql`EXTRACT(EPOCH FROM (NOW() - started_at)) / 60`,
            idleMinutes: String(segmentIdleMins),
          })
          .where(
            and(
              eq(sessionTariffSegments.sessionId, session.sessionId),
              isNull(sessionTariffSegments.endedAt),
            ),
          );

        await tx.insert(sessionTariffSegments).values({
          sessionId: session.sessionId,
          tariffId: currentTariff.id,
          startedAt: now,
          energyWhStart: String(energyWh),
        });

        await tx
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
      });

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
    };

    const BATCH_SIZE = 50;
    for (let i = 0; i < activeSessions.length; i += BATCH_SIZE) {
      const batch = activeSessions.slice(i, i + BATCH_SIZE);
      const results = await Promise.allSettled(batch.map(processSession));
      results.forEach((result, idx) => {
        if (result.status === 'rejected') {
          const failed = batch[idx];
          log.error(
            { sessionId: failed?.sessionId, error: result.reason },
            'Tariff boundary check failed for session',
          );
        }
      });
    }
  }

  if (pushDisplay) {
    await pushAllMessagesToAllStations(log);
  }
}
