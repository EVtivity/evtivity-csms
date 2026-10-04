// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import type postgres from 'postgres';
import { grossUnitPrice, taxRateFraction } from '@evtivity/lib';
import type { TaxBasis } from '@evtivity/lib';
import { loadStationPricing, resolveStationTariff } from './tariff-resolution.js';
import { getCompanyTaxBasis } from './system-settings.js';

/**
 * A hold below the session fee cannot cover a single session: a guest's
 * station stops at once with CostLimitReached (the hold is its maxCost). These
 * readers give the session fee a hold must cover, tax included, in cents,
 * rounded up so a hold of that amount covers it.
 */

function grossFeeCents(
  pricePerSession: string | null | undefined,
  taxRate: string | null | undefined,
  basis: TaxBasis,
): number {
  const fee = Number(pricePerSession ?? 0);
  if (!Number.isFinite(fee) || fee <= 0) return 0;
  const cents = grossUnitPrice(fee, taxRateFraction(taxRate), basis) * 100;
  // Float noise (0.5 * 1.0825 * 100 = 54.12499999...) must not round a cent up.
  return Math.ceil(Math.round(cents * 1e6) / 1e6);
}

/** The session fee, with tax, of the tariff that applies to the driver (null: a guest) at the station now. 0 without one. */
export async function sessionFeeGrossCents(
  q: { stationUuid: string; driverUuid: string | null; at?: Date },
  sql: postgres.Sql,
): Promise<number> {
  const tariff = await resolveStationTariff(q, sql);
  if (tariff == null) return 0;
  return grossFeeCents(tariff.pricePerSession, tariff.taxRate, await getCompanyTaxBasis());
}

/**
 * The highest session fee, with tax, among the active tariffs that apply at the
 * site's stations to a driver without a pricing group (site, station or default
 * group, any time of day). 0 when the site has no station or no fee.
 */
export async function siteMaxSessionFeeGrossCents(
  siteId: string,
  sql: postgres.Sql,
): Promise<number> {
  const stations = await sql<Array<{ id: string }>>`
    SELECT id FROM charging_stations WHERE site_id = ${siteId}
  `;
  const basis = await getCompanyTaxBasis();
  let max = 0;
  for (const station of stations) {
    const pricing = await loadStationPricing({ stationUuid: station.id, driverUuid: null }, sql);
    for (const tariff of pricing?.tariffs ?? []) {
      max = Math.max(max, grossFeeCents(tariff.pricePerSession, tariff.taxRate, basis));
    }
  }
  return max;
}
