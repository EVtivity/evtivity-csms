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
import { and, eq } from 'drizzle-orm';
import {
  mapConnectorTypeToCss,
  randomCssConnectorType,
  buildCssConfigDefaults,
} from '@evtivity/lib';
import type { CssConnectorType } from '@evtivity/lib';
import type { OcppProtocol } from '@evtivity/lib/ocpp-version';

interface PairOptions {
  stationId: string;
  ocppProtocol: OcppProtocol;
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
  // opts.stationId is the OCPP identity (charging_stations.station_id).
  const [parent] = await exec
    .select({
      id: chargingStations.id,
      model: chargingStations.model,
      serialNumber: chargingStations.serialNumber,
      firmwareVersion: chargingStations.firmwareVersion,
      vendorId: chargingStations.vendorId,
    })
    .from(chargingStations)
    .where(eq(chargingStations.stationId, opts.stationId));

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
    const existingEvses =
      parent == null
        ? []
        : await innerTx
            .select({
              evseId: evses.evseId,
              connectorId: connectors.connectorId,
              connectorType: connectors.connectorType,
              maxPowerKw: connectors.maxPowerKw,
            })
            .from(evses)
            .innerJoin(connectors, eq(connectors.evseId, evses.id))
            .where(eq(evses.stationId, parent.id));

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

/**
 * Keeps a paired simulator's credentials in step with a security change made
 * while it is offline, so it reconnects with the password and transport the
 * CSMS now expects. Online changes reach the simulator over OCPP instead.
 */
export async function syncCssStationSecurity(
  stationId: string,
  opts: { securityProfile: number; password?: string | undefined },
  exec: Executor = db,
): Promise<void> {
  const requiresTls = opts.securityProfile >= 2;
  await exec
    .update(cssStations)
    .set({
      targetUrl: requiresTls
        ? (process.env['OCPP_TLS_SERVER_URL'] ?? 'wss://ocpp:8443')
        : (process.env['OCPP_SERVER_URL'] ?? 'ws://ocpp:8080'),
      ...(opts.password != null ? { password: opts.password } : {}),
      updatedAt: new Date(),
    })
    .where(eq(cssStations.stationId, stationId));
}

/** A connector the operator added or edited on a station, as the CSMS stores it. */
export interface MirroredConnector {
  evseId: number;
  connectorId: number;
  connectorType?: string | undefined;
  maxPowerKw?: number | undefined;
}

/**
 * Mirrors connectors the operator added or edited into the paired simulator's
 * css_evses, so its next boot reports the same plugs. `stationId` is the OCPP
 * identity (css_stations.station_id), not the internal station id. Upsert:
 * the pairing seeds a default EVSE 1 / connector 1 the operator may replace.
 * Fields the operator did not send keep their simulator value. No-op for a
 * station without a paired simulator.
 */
export async function mirrorCssConnectors(
  exec: Executor,
  stationId: string,
  rows: readonly MirroredConnector[],
): Promise<void> {
  if (rows.length === 0) return;
  const [css] = await exec
    .select({ id: cssStations.id })
    .from(cssStations)
    .where(eq(cssStations.stationId, stationId));
  if (css == null) return;
  for (const row of rows) {
    const connectorType =
      row.connectorType != null ? mapConnectorTypeToCss(row.connectorType) : undefined;
    const maxPowerW = row.maxPowerKw != null ? Math.round(row.maxPowerKw * 1000) : undefined;
    const set = {
      ...(connectorType != null ? { connectorType } : {}),
      ...(maxPowerW != null ? { maxPowerW } : {}),
    };
    const insert = exec.insert(cssEvses).values({
      cssStationId: css.id,
      evseId: row.evseId,
      connectorId: row.connectorId,
      ...set,
    });
    await (Object.keys(set).length > 0
      ? insert.onConflictDoUpdate({
          target: [cssEvses.cssStationId, cssEvses.evseId, cssEvses.connectorId],
          set,
        })
      : insert.onConflictDoNothing());
  }
}

/**
 * Removes deleted connectors (or a whole EVSE when `connectorId` is omitted)
 * from the paired simulator, so it stops reporting them and the CSMS does not
 * create them again from its StatusNotification. `stationId` is the OCPP
 * identity. No-op for a station without a paired simulator.
 */
export async function removeCssConnectors(
  exec: Executor,
  stationId: string,
  evseId: number,
  connectorId?: number,
): Promise<void> {
  const [css] = await exec
    .select({ id: cssStations.id })
    .from(cssStations)
    .where(eq(cssStations.stationId, stationId));
  if (css == null) return;
  await exec
    .delete(cssEvses)
    .where(
      and(
        eq(cssEvses.cssStationId, css.id),
        eq(cssEvses.evseId, evseId),
        ...(connectorId != null ? [eq(cssEvses.connectorId, connectorId)] : []),
      ),
    );
}
