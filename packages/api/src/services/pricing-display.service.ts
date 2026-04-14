// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { eq } from 'drizzle-orm';
import crypto from 'node:crypto';
import { db, chargingStations, getPricingDisplayFormat } from '@evtivity/database';
import { formatPricingDisplay } from '@evtivity/lib';
import type { FastifyBaseLogger } from 'fastify';
import type { ResolvedTariff } from './tariff.service.js';
import { resolveTariff } from './tariff.service.js';
import { getPubSub } from '../lib/pubsub.js';

// Use a fixed high-range ID so repeated pushes update the same display slot
const PRICING_DISPLAY_MESSAGE_ID = 9999;

export async function pushPricingDisplayToStation(
  stationOcppId: string,
  ocppProtocol: string | null,
  tariff: ResolvedTariff,
  format: string,
): Promise<void> {
  const pubsub = getPubSub();
  const commandId = crypto.randomUUID();
  const displayFormat = format === 'compact' ? 'compact' : 'standard';
  const displayText = formatPricingDisplay(tariff, displayFormat, tariff.currency);

  if (ocppProtocol != null && ocppProtocol.startsWith('ocpp2')) {
    await pubsub.publish(
      'ocpp_commands',
      JSON.stringify({
        commandId,
        stationId: stationOcppId,
        action: 'SetDisplayMessage',
        payload: {
          message: {
            id: PRICING_DISPLAY_MESSAGE_ID,
            priority: 'NormalCycle',
            state: 'Idle',
            message: { format: 'UTF8', content: displayText },
          },
        },
        version: ocppProtocol,
      }),
    );
  } else {
    // OCPP 1.6: use DataTransfer with vendor extension
    await pubsub.publish(
      'ocpp_commands',
      JSON.stringify({
        commandId,
        stationId: stationOcppId,
        action: 'DataTransfer',
        payload: {
          vendorId: 'com.evtivity',
          messageId: 'PricingDisplay',
          data: JSON.stringify({ pricing: displayText }),
        },
        version: 'ocpp1.6',
      }),
    );
  }
}

export async function pushPricingDisplayToAllStations(log: FastifyBaseLogger): Promise<void> {
  const format = await getPricingDisplayFormat();

  const onlineStations = await db
    .select({
      id: chargingStations.id,
      stationId: chargingStations.stationId,
      ocppProtocol: chargingStations.ocppProtocol,
    })
    .from(chargingStations)
    .where(eq(chargingStations.isOnline, true));

  let pushed = 0;
  for (const station of onlineStations) {
    try {
      const tariff = await resolveTariff(station.id, null);
      if (tariff == null) continue;

      await pushPricingDisplayToStation(station.stationId, station.ocppProtocol, tariff, format);
      pushed++;
    } catch (err: unknown) {
      log.warn(
        { stationId: station.stationId, error: err },
        'Failed to push pricing display to station',
      );
    }
  }

  if (pushed > 0) {
    log.info({ pushed }, 'Pricing display pushed to stations');
  }
}
