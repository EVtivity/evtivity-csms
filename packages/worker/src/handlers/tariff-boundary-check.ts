// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { eq, sql } from 'drizzle-orm';
import {
  db,
  client,
  chargingSessions,
  chargingStations,
  getHeartbeatIntervalSeconds,
  isSplitBillingEnabled,
  isStationMessageEnabled,
  priceSessionAt,
  resolveStationTariff,
  sendSessionTariffChange,
  storeRunningCost,
  switchTariffSegment,
} from '@evtivity/database';
import type { Logger } from 'pino';
import { isStationLiveForSegmentSwitch, isTariffFree, publishOcppCommand } from '@evtivity/lib';
import { getPubSub } from '@evtivity/lib/pubsub-instance';
import { pushAllMessagesToAllStations } from '@evtivity/services/station-message.service';

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
        // The group the session started in (B7); a session a release before
        // 0340 started has none, so its tariff's group is read.
        pricingGroupId: sql<string | null>`COALESCE(${chargingSessions.pricingGroupId},
          (SELECT t.pricing_group_id FROM tariffs t WHERE t.id = ${chargingSessions.tariffId}))`,
        tariffPricePerKwh: chargingSessions.tariffPricePerKwh,
        tariffPricePerMinute: chargingSessions.tariffPricePerMinute,
        tariffPricePerSession: chargingSessions.tariffPricePerSession,
        tariffIdleFeePricePerMinute: chargingSessions.tariffIdleFeePricePerMinute,
        tariffReservationFeePerMinute: chargingSessions.tariffReservationFeePerMinute,
        tariffTaxRate: chargingSessions.tariffTaxRate,
        energyDeliveredWh: chargingSessions.energyDeliveredWh,
        stationOcppId: chargingStations.stationId,
        ocppProtocol: chargingStations.ocppProtocol,
        stationOnline: chargingStations.isOnline,
        stationLastActivityAt: chargingStations.lastHeartbeat,
      })
      .from(chargingSessions)
      .innerJoin(chargingStations, eq(chargingSessions.stationId, chargingStations.id))
      .where(eq(chargingSessions.status, 'active'));

    const pubsub = getPubSub();
    const heartbeatSeconds = await getHeartbeatIntervalSeconds();

    // Per-session body has internal sequencing (resolve tariff -> close
    // segment -> open segment -> publish), but every session is
    // independent of every other. The previous serial loop spent (~5 DB
    // queries) * N sessions of wall time per minute; at N=500 this saturates
    // the worker's DB pool. Batch the sessions and run each batch with
    // Promise.allSettled so one session's failure doesn't stop the cron tick.
    const processSession = async (session: (typeof activeSessions)[number]): Promise<void> => {
      // An offline or silent station may be queueing readings and its end:
      // they switch and end the segments at their own timestamps when they
      // arrive (finding B6), so the job does not switch at wall clock.
      if (
        !isStationLiveForSegmentSwitch({
          isOnline: session.stationOnline,
          lastActivityAt: session.stationLastActivityAt,
          now,
          heartbeatSeconds,
        })
      ) {
        return;
      }
      // A session without a tariff at its start has no pricing group and
      // stays unpriced (an assignment applies to the next session).
      if (session.pricingGroupId == null) return;
      const energyWh = session.energyDeliveredWh != null ? Number(session.energyDeliveredWh) : 0;
      // The session's energy so far selects an energy-threshold tariff once
      // the threshold is crossed. Only within the pricing group the session
      // started in (B7).
      const currentTariff = await resolveStationTariff(
        {
          stationUuid: session.stationUuid,
          driverUuid: session.driverId,
          at: now,
          sessionEnergyKwh: energyWh / 1000,
          pricingGroupId: session.pricingGroupId,
        },
        client,
      );
      if (currentTariff == null) return;

      // Under the session row lock: close the open segment (compare-and-set
      // on its id, with the session idle not yet attributed to closed
      // segments) and open one priced from the new tariff. Nothing changes
      // when the open segment already has this tariff, which is also what a
      // MeterValues projection that switched first leaves (finding B1). The
      // session's own tariff snapshot stays the one it started with.
      const switched = await switchTariffSegment(client, {
        sessionId: session.sessionId,
        tariff: currentTariff,
        at: now,
        energyWh,
      });
      if (switched == null) return;

      // A station that calculates the cost locally gets the tariff that
      // applies from now, unless its tariff already describes it (I11).
      await sendSessionTariffChange(client, pubsub, {
        sessionId: session.sessionId,
        at: now,
        energyWh,
      });

      // A session that started free and moved to a paid tariff needs the
      // payment gate (B3), which runs in the OCPP projection: the mark is
      // written here (P4) and the next meter reading runs the gate.
      const startTariff =
        session.tariffId != null
          ? {
              id: session.tariffId,
              pricePerKwh: session.tariffPricePerKwh,
              pricePerMinute: session.tariffPricePerMinute,
              pricePerSession: session.tariffPricePerSession,
              idleFeePricePerMinute: session.tariffIdleFeePricePerMinute,
              reservationFeePerMinute: session.tariffReservationFeePerMinute,
              taxRate: session.tariffTaxRate,
            }
          : null;
      if (isTariffFree(startTariff) && !isTariffFree(currentTariff)) {
        await db
          .update(chargingSessions)
          .set({ paymentGateDueAt: now })
          .where(eq(chargingSessions.id, session.sessionId));
      }

      // The running cost at the boundary, from the one cost assembly, stored
      // with its split and sent to the station below. storeRunningCost writes
      // active sessions only: false means the session ended meanwhile, and its
      // final cost (already sent with the Ended response) is not overwritten
      // on the station by a stale CostUpdated.
      const breakdown = await priceSessionAt(client, session.sessionId, now, energyWh);
      const stored =
        breakdown != null && (await storeRunningCost(client, session.sessionId, breakdown));

      log.info(
        {
          sessionId: session.sessionId,
          oldTariffId: switched.fromTariffId,
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
      // Only a live station gets here (the liveness gate above), so the
      // command is never queued for an offline station and replayed later
      // with a stale cost.
      if (
        breakdown != null &&
        stored &&
        session.ocppProtocol != null &&
        session.ocppProtocol.startsWith('ocpp2')
      ) {
        await publishOcppCommand(pubsub, {
          stationId: session.stationOcppId,
          action: 'CostUpdated',
          payload: {
            totalCost: breakdown.grossCents / 100,
            transactionId: session.transactionId,
          },
          version: session.ocppProtocol,
        });
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
