// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { eq, and } from 'drizzle-orm';
import { db } from '@evtivity/database';
import {
  tariffs,
  pricingGroups,
  pricingGroupStations,
  pricingGroupDrivers,
  pricingGroupFleets,
  pricingGroupSites,
  pricingHolidays,
  fleetDrivers,
  chargingStations,
} from '@evtivity/database';
import { resolveActiveTariff } from '@evtivity/lib';
import type { TariffRestrictions, TariffWithRestrictions } from '@evtivity/lib';

export interface ResolvedTariff {
  id: string;
  name: string;
  currency: string;
  pricePerKwh: string | null;
  pricePerMinute: string | null;
  pricePerSession: string | null;
  idleFeePricePerMinute: string | null;
  reservationFeePerMinute: string | null;
  taxRate: string | null;
  restrictions: TariffRestrictions | null;
  priority: number;
  isDefault: boolean;
}

interface ResolvedGroup {
  groupId: string;
  groupName: string;
}

const groupSelect = {
  groupId: pricingGroups.id,
  groupName: pricingGroups.name,
};

export async function resolveTariffGroup(
  stationUuid: string,
  driverUuid?: string | null,
): Promise<ResolvedGroup | null> {
  // Priority 1: Driver-specific pricing group (applies at all stations)
  if (driverUuid != null) {
    const [driverGroup] = await db
      .select(groupSelect)
      .from(pricingGroupDrivers)
      .innerJoin(pricingGroups, eq(pricingGroupDrivers.pricingGroupId, pricingGroups.id))
      .where(eq(pricingGroupDrivers.driverId, driverUuid))
      .limit(1);
    if (driverGroup != null) return driverGroup;
  }

  // Priority 2: Fleet-specific pricing group (applies at all stations)
  if (driverUuid != null) {
    const [fleetGroup] = await db
      .select(groupSelect)
      .from(fleetDrivers)
      .innerJoin(pricingGroupFleets, eq(pricingGroupFleets.fleetId, fleetDrivers.fleetId))
      .innerJoin(pricingGroups, eq(pricingGroupFleets.pricingGroupId, pricingGroups.id))
      .where(eq(fleetDrivers.driverId, driverUuid))
      .limit(1);
    if (fleetGroup != null) return fleetGroup;
  }

  // Priority 3: Station pricing group
  const [stationGroup] = await db
    .select(groupSelect)
    .from(pricingGroupStations)
    .innerJoin(pricingGroups, eq(pricingGroupStations.pricingGroupId, pricingGroups.id))
    .where(eq(pricingGroupStations.stationId, stationUuid))
    .limit(1);
  if (stationGroup != null) return stationGroup;

  // Priority 4: Site-specific pricing group
  const [siteGroup] = await db
    .select(groupSelect)
    .from(chargingStations)
    .innerJoin(pricingGroupSites, eq(pricingGroupSites.siteId, chargingStations.siteId))
    .innerJoin(pricingGroups, eq(pricingGroupSites.pricingGroupId, pricingGroups.id))
    .where(eq(chargingStations.id, stationUuid))
    .limit(1);
  if (siteGroup != null) return siteGroup;

  // Priority 5: Default pricing group
  const [defaultGroup] = await db
    .select(groupSelect)
    .from(pricingGroups)
    .where(eq(pricingGroups.isDefault, true))
    .limit(1);
  if (defaultGroup != null) return defaultGroup;

  return null;
}

async function loadHolidays(): Promise<Date[]> {
  const rows = await db.select({ date: pricingHolidays.date }).from(pricingHolidays);
  return rows.map((r) => new Date(r.date));
}

export function isTariffFree(tariff: ResolvedTariff | null): boolean {
  if (tariff == null) return true;
  return (
    (tariff.pricePerKwh == null || Number(tariff.pricePerKwh) === 0) &&
    (tariff.pricePerMinute == null || Number(tariff.pricePerMinute) === 0) &&
    (tariff.pricePerSession == null || Number(tariff.pricePerSession) === 0) &&
    (tariff.idleFeePricePerMinute == null || Number(tariff.idleFeePricePerMinute) === 0)
  );
}

export async function resolveTariff(
  stationUuid: string,
  driverUuid: string | null,
): Promise<ResolvedTariff | null> {
  const group = await resolveTariffGroup(stationUuid, driverUuid);
  if (group == null) return null;

  // Fetch ALL active tariffs in the resolved group
  const activeTariffs = await db
    .select({
      id: tariffs.id,
      name: tariffs.name,
      currency: tariffs.currency,
      pricePerKwh: tariffs.pricePerKwh,
      pricePerMinute: tariffs.pricePerMinute,
      pricePerSession: tariffs.pricePerSession,
      idleFeePricePerMinute: tariffs.idleFeePricePerMinute,
      reservationFeePerMinute: tariffs.reservationFeePerMinute,
      taxRate: tariffs.taxRate,
      restrictions: tariffs.restrictions,
      priority: tariffs.priority,
      isDefault: tariffs.isDefault,
    })
    .from(tariffs)
    .where(and(eq(tariffs.pricingGroupId, group.groupId), eq(tariffs.isActive, true)));

  if (activeTariffs.length === 0) return null;

  const holidays = await loadHolidays();
  const now = new Date();

  const tariffInputs: TariffWithRestrictions[] = activeTariffs.map((t) => ({
    id: t.id,
    currency: t.currency,
    pricePerKwh: t.pricePerKwh,
    pricePerMinute: t.pricePerMinute,
    pricePerSession: t.pricePerSession,
    idleFeePricePerMinute: t.idleFeePricePerMinute,
    reservationFeePerMinute: t.reservationFeePerMinute,
    taxRate: t.taxRate,
    restrictions: t.restrictions as TariffRestrictions | null,
    priority: t.priority,
    isDefault: t.isDefault,
  }));

  const resolved = resolveActiveTariff(tariffInputs, now, holidays, 0);
  if (resolved == null) return null;

  const match = activeTariffs.find((t) => t.id === resolved.id);
  if (match == null) return null;

  return {
    id: match.id,
    name: match.name,
    currency: match.currency,
    pricePerKwh: match.pricePerKwh,
    pricePerMinute: match.pricePerMinute,
    pricePerSession: match.pricePerSession,
    idleFeePricePerMinute: match.idleFeePricePerMinute,
    reservationFeePerMinute: match.reservationFeePerMinute,
    taxRate: match.taxRate,
    restrictions: match.restrictions as TariffRestrictions | null,
    priority: match.priority,
    isDefault: match.isDefault,
  };
}
