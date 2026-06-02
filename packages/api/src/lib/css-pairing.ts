// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import {
  db,
  cssStations,
  cssEvses,
  cssConfigVariables,
  evses,
  connectors,
  chargingStations,
  vendors,
} from '@evtivity/database';
import { eq } from 'drizzle-orm';
import {
  mapConnectorTypeToCss,
  randomCssConnectorType,
  buildCssConfigDefaults,
} from '@evtivity/lib';
import type { CssConnectorType } from '@evtivity/lib';

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

interface PairCssEvse {
  evseId: number;
  connectorId: number;
  connectorType: CssConnectorType;
  maxPowerW: number;
  phases: number;
  voltage: number;
}

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

  // Parent station metadata feeds the device-identity keys in the config
  // defaults (ChargingStation.VendorName, ChargePointModel, etc.).
  const [parent] = await exec
    .select({
      model: chargingStations.model,
      serialNumber: chargingStations.serialNumber,
      firmwareVersion: chargingStations.firmwareVersion,
      vendorId: chargingStations.vendorId,
    })
    .from(chargingStations)
    .where(eq(chargingStations.id, opts.stationId));

  let vendorName = 'EVtivity';
  if (parent?.vendorId != null) {
    const [vendor] = await exec
      .select({ name: vendors.name })
      .from(vendors)
      .where(eq(vendors.id, parent.vendorId));
    if (vendor?.name != null && vendor.name !== '') vendorName = vendor.name;
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

    // Build the EVSE set for this device's hardware spec. If the parent
    // station already has evses/connectors, mirror them. Otherwise create
    // a single default EVSE with a randomly-picked plug type so the
    // freshly-provisioned fleet has variety.
    const existingEvses = await innerTx
      .select({
        evseId: evses.evseId,
        connectorId: connectors.connectorId,
        connectorType: connectors.connectorType,
        maxPowerKw: connectors.maxPowerKw,
      })
      .from(evses)
      .innerJoin(connectors, eq(connectors.evseId, evses.id))
      .where(eq(evses.stationId, opts.stationId));

    let pairedEvses: PairCssEvse[];
    if (existingEvses.length > 0) {
      pairedEvses = existingEvses.map((e) => ({
        evseId: e.evseId,
        connectorId: e.connectorId,
        connectorType: mapConnectorTypeToCss(e.connectorType),
        maxPowerW: e.maxPowerKw != null ? Math.round(Number(e.maxPowerKw) * 1000) : 22000,
        phases: 3,
        voltage: 230,
      }));
    } else {
      pairedEvses = [
        {
          evseId: 1,
          connectorId: 1,
          connectorType: randomCssConnectorType(),
          maxPowerW: 22000,
          phases: 3,
          voltage: 230,
        },
      ];
    }
    await innerTx.insert(cssEvses).values(
      pairedEvses.map((e) => ({
        cssStationId: created.id,
        evseId: e.evseId,
        connectorId: e.connectorId,
        connectorType: e.connectorType,
        maxPowerW: e.maxPowerW,
        phases: e.phases,
        voltage: e.voltage,
      })),
    );

    // Seed the device's persistent configuration so the simulator boots
    // from device storage, not in-memory defaults. Includes per-EVSE
    // Connector[*,*].ConnectorType keyed off the css_evses plug type.
    const defaults = buildCssConfigDefaults({
      ocppProtocol: opts.ocppProtocol,
      stationId: opts.stationId,
      vendorName,
      model: parent?.model ?? 'CSS-1000',
      serialNumber: parent?.serialNumber ?? `SN-${opts.stationId}`,
      firmwareVersion: parent?.firmwareVersion ?? '1.0.0',
      securityProfile: opts.securityProfile,
      targetUrl,
      evses: pairedEvses,
    });
    if (defaults.length > 0) {
      await innerTx.insert(cssConfigVariables).values(
        defaults.map((d) => ({
          cssStationId: created.id,
          key: d.key,
          value: d.value,
          readonly: d.readonly,
        })),
      );
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
