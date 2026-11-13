// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

// Connector tariff_ids (OCPI 2.3.0 8.3.3): the published tariff a partner
// sees for a station. The station's pricing group comes from the one tariff
// resolver (`loadStationPricing`, no driver), and the id from the partner's
// tariff mappings, so a connector points at the same tariff GET /cpo/tariffs
// and the CDRs publish.

import { hasChargingTypeTariffs, ocpiKindTariffId } from '@evtivity/lib';
import type { ConnectorTariffIds } from '../transformers/location.transformer.js';
import type { ChargingKind } from '@evtivity/lib';
import { client, getPricingHolidays, loadStationPricing, pickTariff } from '@evtivity/database';
import type { StationPricing } from '@evtivity/database';
import { partnerTariffMappings } from './published-tariffs.js';
import type { TariffMappingRow } from './published-tariffs.js';

export interface TariffStation {
  /** Internal station id. */
  id: string;
  /** The station's site has free vend: nothing is charged, so no paid tariff is linked. */
  freeVend: boolean;
}

/** The partner's own mapping first, then by OCPI id (as `sessionTariffMapping`). */
function preferred(candidates: TariffMappingRow[]): TariffMappingRow | null {
  const sorted = [...candidates].sort(
    (a, b) =>
      Number(b.partnerId != null) - Number(a.partnerId != null) ||
      a.ocpiTariffId.localeCompare(b.ocpiTariffId),
  );
  return sorted[0] ?? null;
}

/**
 * The OCPI tariff ids for a station's connectors, or null. A mapping of the
 * station's pricing group wins, because it publishes every tariff of the
 * group with its restrictions; a group whose tariffs differ by charging type
 * is published per kind (`<id>-AC`, `<id>-DC`). Otherwise the mapping of the
 * tariff that applies now (in the site timezone), per kind when the AC and
 * DC tariffs differ. OCPI allows one active tariff per Tariff.type, and
 * published tariffs carry no type.
 */
export function stationTariffId(
  pricing: StationPricing | null,
  mappings: readonly TariffMappingRow[],
  holidays: Date[],
  now: Date,
): ConnectorTariffIds | null {
  if (pricing == null) return null;
  const groupMapping = preferred(mappings.filter((m) => m.pricingGroupId === pricing.group.id));
  if (groupMapping != null) {
    if (!hasChargingTypeTariffs(pricing.tariffs)) return [groupMapping.ocpiTariffId];
    return {
      ac: [ocpiKindTariffId(groupMapping.ocpiTariffId, 'ac')],
      dc: [ocpiKindTariffId(groupMapping.ocpiTariffId, 'dc')],
    };
  }
  const idFor = (chargingKind: ChargingKind | null): string | null => {
    const current = pickTariff(
      pricing.tariffs,
      { at: now, timezone: pricing.timezone, chargingKind, siteId: pricing.siteId },
      holidays,
    );
    if (current == null) return null;
    return preferred(mappings.filter((m) => m.tariffId === current.id))?.ocpiTariffId ?? null;
  };
  if (!hasChargingTypeTariffs(pricing.tariffs)) {
    const id = idFor(null);
    return id != null ? [id] : null;
  }
  const ac = idFor('ac');
  const dc = idFor('dc');
  if (ac == null && dc == null) return null;
  if (ac === dc) return [ac as string];
  return { ac: ac != null ? [ac] : [], dc: dc != null ? [dc] : [] };
}

/**
 * Connector tariff ids per station (internal id) for one partner. Stations
 * without a published tariff, and stations at free-vend sites, are absent.
 */
export async function connectorTariffIds(
  partnerId: string,
  stations: readonly TariffStation[],
  now: Date = new Date(),
): Promise<Map<string, ConnectorTariffIds>> {
  const result = new Map<string, ConnectorTariffIds>();
  const priced = stations.filter((s) => !s.freeVend);
  if (priced.length === 0) return result;
  const mappings = await partnerTariffMappings(partnerId);
  if (mappings.length === 0) return result;

  const holidays = await getPricingHolidays(client);
  const pricings = await Promise.all(
    priced.map((s) => loadStationPricing({ stationUuid: s.id, driverUuid: null }, client)),
  );
  priced.forEach((station, i) => {
    const id = stationTariffId(pricings[i] ?? null, mappings, holidays, now);
    if (id != null) result.set(station.id, id);
  });
  return result;
}

export type { ConnectorTariffIds } from '../transformers/location.transformer.js';
