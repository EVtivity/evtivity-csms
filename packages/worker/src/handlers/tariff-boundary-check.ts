// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { eq } from 'drizzle-orm';
import {
  db,
  client,
  chargingSessions,
  chargingStations,
  isSplitBillingEnabled,
  isStationMessageEnabled,
  openSegmentTariffId,
  priceSessionAt,
  sessionIdleMinutesAt,
  storeRunningCost,
  switchTariffSegment,
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
        transactionId: chargingSessions.transactionId,
        stationUuid: chargingSessions.stationId,
        driverId: chargingSessions.driverId,
        tariffId: chargingSessions.tariffId,
        energyDeliveredWh: chargingSessions.energyDeliveredWh,
        idleMinutes: chargingSessions.idleMinutes,
        idleStartedAt: chargingSessions.idleStartedAt,
        currentCostCents: chargingSessions.currentCostCents,
        stationOcppId: chargingStations.stationId,
        ocppProtocol: chargingStations.ocppProtocol,
      })
      .from(chargingSessions)
      .innerJoin(chargingStations, eq(chargingSessions.stationId, chargingStations.id))
      .where(eq(chargingSessions.status, 'active'));

    const pubsub = getPubSub();

    // Per-session body has internal sequencing (resolve tariff -> close
    // segment -> open segment -> publish), but every session is
    // independent of every other. The previous serial loop spent (~5 DB
    // queries) * N sessions of wall time per minute; at N=500 this saturates
    // the worker's DB pool. Batch the sessions and run each batch with
    // Promise.allSettled so one session's failure doesn't stop the cron tick.
    const processSession = async (session: (typeof activeSessions)[number]): Promise<void> => {
      const currentTariff = await resolveTariff(session.stationUuid, session.driverId);
      if (currentTariff == null) return;
      // Compare with the tariff of the open segment. The session's own tariff
      // snapshot (and its tax rate) stays the one it started with (issue #33).
      const openTariffId =
        (await openSegmentTariffId(client, session.sessionId)) ?? session.tariffId;
      if (currentTariff.id === openTariffId) return;

      const energyWh = session.energyDeliveredWh != null ? Number(session.energyDeliveredWh) : 0;

      // Close the open segment (with the session idle not yet attributed to
      // closed segments, including an idle period still running) and open one
      // priced from the new tariff, in one transaction.
      await switchTariffSegment(client, {
        sessionId: session.sessionId,
        tariff: currentTariff,
        at: now,
        energyWh,
        sessionIdleMinutes: sessionIdleMinutesAt(
          { idleStartedAt: session.idleStartedAt, idleMinutes: Number(session.idleMinutes) },
          now,
        ),
      });

      // The running cost at the boundary, from the one cost assembly, stored
      // with its split and sent to the station below.
      const breakdown = await priceSessionAt(client, session.sessionId, now, energyWh);
      const runningCostCents =
        breakdown != null && (await storeRunningCost(client, session.sessionId, breakdown))
          ? breakdown.grossCents
          : session.currentCostCents;

      log.info(
        {
          sessionId: session.sessionId,
          oldTariffId: openTariffId,
          newTariffId: currentTariff.id,
        },
        'Tariff boundary: split session at new tariff',
      );

      // Notify OCPP 2.1 stations of cost update (fire-and-forget). OCPP
      // CostUpdated.transactionId is the OCPP-level transaction identifier
      // the station chose, NOT our internal session UUID. The earlier
      // payload used session.sessionId (our internal nanoid PK) so stations
      // couldn't correlate the update with any of their active
      // transactions and silently dropped it.
      if (session.ocppProtocol != null && session.ocppProtocol.startsWith('ocpp2')) {
        const commandId = crypto.randomUUID();
        await pubsub.publish(
          'ocpp_commands',
          JSON.stringify({
            commandId,
            stationId: session.stationOcppId,
            action: 'CostUpdated',
            payload: {
              totalCost: (runningCostCents ?? 0) / 100,
              transactionId: session.transactionId,
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
