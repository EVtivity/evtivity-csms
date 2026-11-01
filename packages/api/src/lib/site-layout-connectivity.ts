// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

// The reported link of each cellular station on the site layout (GET
// /v1/sites/:id/layout `signal` and `networkType`). The route decides what the
// request may see: stations:read, as the station SIM status (GET
// /v1/stations/:id/sim); the stations are those of a site in the caller's
// scope. The values come from `stationLinkSummaries`, which reads the stored
// DataLink signal and the SIM sessions of the station's confirmed attachment
// inside the station window (`stationSimView`), so a SIM's time at another
// station or site never shows. Nothing is read while the SIM features are off.

import type { FastifyBaseLogger } from 'fastify';
import { and, eq, inArray } from 'drizzle-orm';
import { db, stationConfigurations } from '@evtivity/database';
import { signalBars, type SignalBars } from '@evtivity/lib';
import { stationLinkSummaries } from '@evtivity/services/station-sim.service';
import { isSimFeatureOn, readSimSettings, simProviderRegistry } from './sim.js';

const OCPP_VERSIONS = {
  'ocpp1.6': '1.6',
  'ocpp2.0.1': '2.0.1',
  'ocpp2.1': '2.1',
} as const;

export type LayoutOcppVersion = (typeof OCPP_VERSIONS)[keyof typeof OCPP_VERSIONS];

/** The OCPP version of a stored protocol (`charging_stations.ocpp_protocol`), null when unknown. */
export function layoutOcppVersion(protocol: string | null | undefined): LayoutOcppVersion | null {
  if (protocol == null || !Object.hasOwn(OCPP_VERSIONS, protocol)) return null;
  return OCPP_VERSIONS[protocol as keyof typeof OCPP_VERSIONS];
}

export interface LayoutStationSignal {
  bars: SignalBars;
  dbm: number;
}

export interface LayoutStationLink {
  networkType: string | null;
  signal: LayoutStationSignal | null;
}

/**
 * The reported network type and signal bars of the given cellular stations.
 * Fail-open: a settings or read failure is logged and the layout shows no
 * signal (the connection type still shows from the data plan).
 */
export async function readLayoutStationLinks(
  cellularStationIds: readonly string[],
  log: Pick<FastifyBaseLogger, 'warn'>,
): Promise<Map<string, LayoutStationLink>> {
  const out = new Map<string, LayoutStationLink>();
  if (cellularStationIds.length === 0) return out;
  try {
    const simSettings = await readSimSettings();
    if (!isSimFeatureOn(simSettings)) return out;
    const enabledProviders = (await simProviderRegistry().enabledProviders()).map((p) => p.id);
    const summaries = await stationLinkSummaries(cellularStationIds, {
      signalEnabled: simSettings.stationSignalEnabled,
      enabledProviders,
    });
    for (const [stationId, summary] of summaries) {
      const bars = signalBars(summary.signalDbm);
      out.set(stationId, {
        networkType: summary.networkType,
        signal: bars != null && summary.signalDbm != null ? { bars, dbm: summary.signalDbm } : null,
      });
    }
  } catch (err: unknown) {
    log.warn({ err }, 'Site layout station signal not read; the layout shows no signal');
  }
  return out;
}

/** How a station that is not cellular connects, as it reported its active network interface. */
export type LayoutWiredLink = 'wifi' | 'wired';

/**
 * The active network interface of an OCPP 2.0.1 or 2.1 station, from its
 * reported device model: `OCPPCommCtrlr.ActiveNetworkProfile` names the
 * network configuration slot in use (2.1), else the first slot of
 * `OCPPCommCtrlr.NetworkConfigurationPriority`; that slot's
 * `NetworkConfiguration.OcppInterface` is `Wired0` to `Wired3` (wired) or
 * `Wireless0` to `Wireless3` (OCPP 2.1 Part 2, OCPPInterfaceEnumType). A
 * wireless interface counts as Wi-Fi only for a station the CSMS does not
 * know as cellular (the caller passes those only). `Any`, a missing value and
 * an OCPP 1.6 station (no such variables) give nothing: the station then
 * shows Wi-Fi or Wired.
 */
export function activeNetworkLink(
  rows: ReadonlyArray<{
    component: string;
    instance: string | null;
    variable: string;
    value: string | null;
  }>,
): LayoutWiredLink | null {
  const value = (component: string, variable: string, instance?: string): string | null =>
    rows.find(
      (r) =>
        r.component === component &&
        r.variable === variable &&
        (instance == null || r.instance === instance),
    )?.value ?? null;
  const active = value('OCPPCommCtrlr', 'ActiveNetworkProfile')?.trim();
  const priority = value('OCPPCommCtrlr', 'NetworkConfigurationPriority')?.split(',')[0]?.trim();
  const slot = active != null && active !== '' ? active : priority;
  if (slot == null || slot === '') return null;
  const iface = value('NetworkConfiguration', 'OcppInterface', slot);
  if (iface == null) return null;
  if (/^Wired[0-3]$/.test(iface)) return 'wired';
  if (/^Wireless[0-3]$/.test(iface)) return 'wifi';
  return null;
}

/**
 * The reported active network interface of the given stations (those not
 * known as cellular). Fail-open: a read failure is logged and the stations
 * show Wi-Fi or Wired.
 */
export async function readLayoutWiredLinks(
  stationIds: readonly string[],
  log: Pick<FastifyBaseLogger, 'warn'>,
): Promise<Map<string, LayoutWiredLink>> {
  const out = new Map<string, LayoutWiredLink>();
  if (stationIds.length === 0) return out;
  try {
    const rows = await db
      .select({
        stationId: stationConfigurations.stationId,
        component: stationConfigurations.component,
        instance: stationConfigurations.instance,
        variable: stationConfigurations.variable,
        value: stationConfigurations.value,
      })
      .from(stationConfigurations)
      .where(
        and(
          inArray(stationConfigurations.stationId, [...stationIds]),
          eq(stationConfigurations.attributeType, 'Actual'),
          inArray(stationConfigurations.component, ['OCPPCommCtrlr', 'NetworkConfiguration']),
          inArray(stationConfigurations.variable, [
            'ActiveNetworkProfile',
            'NetworkConfigurationPriority',
            'OcppInterface',
          ]),
        ),
      );
    const byStation = new Map<string, typeof rows>();
    for (const row of rows) {
      byStation.set(row.stationId, [...(byStation.get(row.stationId) ?? []), row]);
    }
    for (const [stationId, list] of byStation) {
      const link = activeNetworkLink(list);
      if (link != null) out.set(stationId, link);
    }
  } catch (err: unknown) {
    log.warn({ err }, 'Site layout network interfaces not read; the layout shows Wi-Fi or Wired');
  }
  return out;
}
