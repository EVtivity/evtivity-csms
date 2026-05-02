// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { db, cssStations, cssEvses, cssConfigVariables } from '@evtivity/database';
import { eq } from 'drizzle-orm';
import { OCPP21_CONFIG_DEFAULTS, OCPP16_CONFIG_DEFAULTS } from './css-config-defaults.js';

interface PairOptions {
  stationId: string;
  ocppProtocol: 'ocpp1.6' | 'ocpp2.1';
  securityProfile: number;
  serverUrl: string;
  tlsServerUrl: string;
  password?: string | null;
  clientCert?: string | null;
  clientKey?: string | null;
  caCert?: string | null;
}

export async function enableCssPair(opts: PairOptions): Promise<void> {
  const requiresTls = opts.securityProfile >= 2;
  const targetUrl = requiresTls ? opts.tlsServerUrl : opts.serverUrl;

  const [existing] = await db
    .select({ id: cssStations.id })
    .from(cssStations)
    .where(eq(cssStations.stationId, opts.stationId));

  if (existing != null) {
    await db
      .update(cssStations)
      .set({ enabled: true, updatedAt: new Date() })
      .where(eq(cssStations.id, existing.id));
    return;
  }

  await db.transaction(async (tx) => {
    const [created] = await tx
      .insert(cssStations)
      .values({
        stationId: opts.stationId,
        targetUrl,
        password: opts.password ?? null,
        clientCert: opts.clientCert ?? null,
        clientKey: opts.clientKey ?? null,
        caCert: opts.caCert ?? null,
        sourceType: 'api',
        enabled: true,
      })
      .returning({ id: cssStations.id });

    if (created == null) return;

    // Default single EVSE so the simulator can boot
    await tx.insert(cssEvses).values({
      cssStationId: created.id,
      evseId: 1,
      connectorId: 1,
    });

    const defaults =
      opts.ocppProtocol === 'ocpp1.6' ? OCPP16_CONFIG_DEFAULTS : OCPP21_CONFIG_DEFAULTS;
    for (const [key, value] of Object.entries(defaults)) {
      await tx.insert(cssConfigVariables).values({ cssStationId: created.id, key, value });
    }
  });
}

export async function disableCssPair(stationId: string): Promise<void> {
  await db
    .update(cssStations)
    .set({ enabled: false, updatedAt: new Date() })
    .where(eq(cssStations.stationId, stationId));
}
