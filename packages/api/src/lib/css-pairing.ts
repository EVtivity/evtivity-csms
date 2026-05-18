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

// Executor accepted by enableCssPair / disableCssPair: either the shared db
// instance or a Drizzle transaction. Both expose the same select/insert/update
// query builders that this helper needs.
type Executor = typeof db | Parameters<Parameters<typeof db.transaction>[0]>[0];

export async function enableCssPair(opts: PairOptions, tx?: Executor): Promise<void> {
  const exec = tx ?? db;
  const requiresTls = opts.securityProfile >= 2;
  const targetUrl = requiresTls ? opts.tlsServerUrl : opts.serverUrl;

  const [existing] = await exec
    .select({ id: cssStations.id })
    .from(cssStations)
    .where(eq(cssStations.stationId, opts.stationId));

  if (existing != null) {
    await exec
      .update(cssStations)
      .set({ enabled: true, updatedAt: new Date() })
      .where(eq(cssStations.id, existing.id));
    return;
  }

  const doInserts = async (innerTx: Executor): Promise<void> => {
    const [created] = await innerTx
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
    await innerTx.insert(cssEvses).values({
      cssStationId: created.id,
      evseId: 1,
      connectorId: 1,
    });

    // Batch the config-defaults insert. OCPP 2.1 has ~100 default keys; the
    // previous per-key loop fired one INSERT per key, multiplying the
    // round-trip cost of every css_stations pair-create by ~100x.
    const defaults =
      opts.ocppProtocol === 'ocpp1.6' ? OCPP16_CONFIG_DEFAULTS : OCPP21_CONFIG_DEFAULTS;
    const configRows = Object.entries(defaults).map(([key, value]) => ({
      cssStationId: created.id,
      key,
      value,
    }));
    if (configRows.length > 0) {
      await innerTx.insert(cssConfigVariables).values(configRows);
    }
  };

  // When called inside a parent transaction, reuse it so a partial failure
  // rolls back together with the parent. Otherwise open a local transaction
  // so the multi-table inserts stay atomic on their own.
  if (tx != null) {
    await doInserts(tx);
  } else {
    await db.transaction(doInserts);
  }
}

export async function disableCssPair(stationId: string, tx?: Executor): Promise<void> {
  const exec = tx ?? db;
  await exec
    .update(cssStations)
    .set({ enabled: false, updatedAt: new Date() })
    .where(eq(cssStations.stationId, stationId));
}
