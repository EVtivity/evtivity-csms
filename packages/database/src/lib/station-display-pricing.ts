// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

// The prices a station-level view shows before the EVSE is known (idle
// station screens, the site layout screen preview): the station's only
// charging kind, the price AC and DC agree on, else the AC and DC prices side
// by side (AC and DC tariffs, owner decisions 2026-11-13). The Both tariff is
// what no AC-only or DC-only session pays, so it is shown alone only for a
// station whose EVSEs have no typed connector.

import type postgres from 'postgres';
import { chargingKindsOf } from '@evtivity/lib';
import type { ChargingKind } from '@evtivity/lib';
import { loadStationEvseKinds } from './charging-kind.js';
import { resolveStationTariff } from './tariff-resolution.js';
import type { StationTariff } from './tariff-resolution.js';

export interface StationDisplayPricing {
  /** The tariff the single-price view shows (null: no tariff applies). */
  tariff: StationTariff | null;
  /** The AC and DC tariffs when the station has both kinds and their prices differ. */
  byKind: { ac: StationTariff; dc: StationTariff } | null;
}

function samePrices(a: StationTariff, b: StationTariff): boolean {
  return (
    a.pricePerKwh === b.pricePerKwh &&
    a.pricePerMinute === b.pricePerMinute &&
    a.pricePerSession === b.pricePerSession &&
    a.idleFeePricePerMinute === b.idleFeePricePerMinute &&
    a.taxRate === b.taxRate
  );
}

/** The station-level display prices for a driver (null: a walk-up driver). */
export async function resolveStationDisplayPricing(
  sql: postgres.Sql,
  stationUuid: string,
  driverUuid: string | null = null,
): Promise<StationDisplayPricing> {
  const kinds = chargingKindsOf([...(await loadStationEvseKinds(sql, stationUuid)).values()]);
  const resolve = (chargingKind: ChargingKind | null): Promise<StationTariff | null> =>
    resolveStationTariff({ stationUuid, driverUuid, chargingKind }, sql);
  if (kinds.length < 2) {
    return { tariff: await resolve(kinds[0] ?? null), byKind: null };
  }
  const [ac, dc] = await Promise.all([resolve('ac'), resolve('dc')]);
  if (ac != null && dc != null) {
    return samePrices(ac, dc) ? { tariff: ac, byKind: null } : { tariff: ac, byKind: { ac, dc } };
  }
  return { tariff: ac ?? dc, byKind: null };
}
