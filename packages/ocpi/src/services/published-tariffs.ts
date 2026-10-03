// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

// Published OCPI tariffs. An `ocpi_tariff_mappings` row names the OCPI tariff
// id a partner sees and the internal tariff or pricing group it is generated
// from. Every GET, push, and CDR renders the tariff from that source with
// `transformTariff`, so prices, tax, and currency are the ones billed.

import { eq, isNull, or } from 'drizzle-orm';
import {
  db,
  ocpiTariffMappings,
  pricingGroups,
  pricingHolidays,
  tariffs,
  getCompanyCurrency,
  getCompanyTaxBasis,
} from '@evtivity/database';
import type { TariffRestrictions } from '@evtivity/lib';
import { config } from '../lib/config.js';
import { transformTariff } from '../transformers/tariff.transformer.js';
import type { TariffSource } from '../transformers/tariff.transformer.js';
import type { OcpiTariff, OcpiVersion } from '../types/ocpi.js';
import type { Ocpi230Tariff } from '../types/ocpi-2.3.0.js';

export interface TariffMappingRow {
  id: number;
  tariffId: string | null;
  pricingGroupId: string | null;
  partnerId: string | null;
  ocpiTariffId: string;
  updatedAt: Date;
}

export type PublishedTariff = OcpiTariff | Ocpi230Tariff;

const mappingColumns = {
  id: ocpiTariffMappings.id,
  tariffId: ocpiTariffMappings.tariffId,
  pricingGroupId: ocpiTariffMappings.pricingGroupId,
  partnerId: ocpiTariffMappings.partnerId,
  ocpiTariffId: ocpiTariffMappings.ocpiTariffId,
  updatedAt: ocpiTariffMappings.updatedAt,
};

/**
 * The mappings in effect for a partner, one per OCPI tariff id: the partner's
 * own mapping replaces a global one (partner_id null) with the same id.
 */
export function effectiveMappings(
  rows: readonly TariffMappingRow[],
  partnerId: string,
): TariffMappingRow[] {
  const byId = new Map<string, TariffMappingRow>();
  for (const row of rows) {
    if (row.partnerId != null && row.partnerId !== partnerId) continue;
    const current = byId.get(row.ocpiTariffId);
    if (current == null || (current.partnerId == null && row.partnerId != null)) {
      byId.set(row.ocpiTariffId, row);
    }
  }
  return [...byId.values()];
}

/** The tariff mappings a partner sees (its own and the global ones). */
export async function partnerTariffMappings(partnerId: string): Promise<TariffMappingRow[]> {
  const rows = await db
    .select(mappingColumns)
    .from(ocpiTariffMappings)
    .where(or(isNull(ocpiTariffMappings.partnerId), eq(ocpiTariffMappings.partnerId, partnerId)));
  return effectiveMappings(rows, partnerId);
}

/**
 * The mappings generated from a changed internal tariff or pricing group: the
 * mappings to the tariff, to its pricing group, or to the group. Both null
 * (a holiday change) returns every mapping.
 */
export async function mappingsForPricingChange(change: {
  tariffId?: string | null;
  pricingGroupId?: string | null;
}): Promise<TariffMappingRow[]> {
  const conditions = [];
  if (change.tariffId != null) {
    conditions.push(eq(ocpiTariffMappings.tariffId, change.tariffId));
  }
  if (change.pricingGroupId != null) {
    conditions.push(eq(ocpiTariffMappings.pricingGroupId, change.pricingGroupId));
  }
  const query = db.select(mappingColumns).from(ocpiTariffMappings);
  return conditions.length > 0 ? query.where(or(...conditions)) : query;
}

/** The mapping that publishes a session's tariff to a partner, if any. */
export async function sessionTariffMapping(
  partnerId: string,
  tariffId: string,
): Promise<TariffMappingRow | null> {
  const [tariff] = await db
    .select({ pricingGroupId: tariffs.pricingGroupId })
    .from(tariffs)
    .where(eq(tariffs.id, tariffId))
    .limit(1);
  const candidates = (await partnerTariffMappings(partnerId)).filter(
    (m) =>
      m.tariffId === tariffId || (tariff != null && m.pricingGroupId === tariff.pricingGroupId),
  );
  // The partner's own mapping first, then a mapping to the tariff itself
  // before one to its pricing group.
  candidates.sort(
    (a, b) =>
      Number(b.partnerId != null) - Number(a.partnerId != null) ||
      Number(b.tariffId != null) - Number(a.tariffId != null) ||
      a.ocpiTariffId.localeCompare(b.ocpiTariffId),
  );
  return candidates[0] ?? null;
}

function toIsoDate(value: string | Date): string {
  return typeof value === 'string' ? value.slice(0, 10) : value.toISOString().slice(0, 10);
}

function latest(dates: readonly Date[]): Date {
  return new Date(Math.max(...dates.map((d) => d.getTime())));
}

/**
 * A mapping rendered as the OCPI Tariff of a version, in the company
 * currency. Null when its source no longer exists.
 */
export async function renderTariffMapping(
  mapping: TariffMappingRow,
  version: OcpiVersion,
  now: Date = new Date(),
): Promise<PublishedTariff | null> {
  const columns = {
    id: tariffs.id,
    pricePerKwh: tariffs.pricePerKwh,
    pricePerMinute: tariffs.pricePerMinute,
    pricePerSession: tariffs.pricePerSession,
    idleFeePricePerMinute: tariffs.idleFeePricePerMinute,
    reservationFeePerMinute: tariffs.reservationFeePerMinute,
    taxRate: tariffs.taxRate,
    restrictions: tariffs.restrictions,
    priority: tariffs.priority,
    isDefault: tariffs.isDefault,
    isActive: tariffs.isActive,
    updatedAt: tariffs.updatedAt,
  };

  let rows: Array<Omit<TariffSource, 'restrictions'> & { restrictions: unknown; updatedAt: Date }>;
  const updated: Date[] = [mapping.updatedAt];
  if (mapping.tariffId != null) {
    rows = await db.select(columns).from(tariffs).where(eq(tariffs.id, mapping.tariffId));
    if (rows.length === 0) return null;
  } else if (mapping.pricingGroupId != null) {
    const [group] = await db
      .select({ updatedAt: pricingGroups.updatedAt })
      .from(pricingGroups)
      .where(eq(pricingGroups.id, mapping.pricingGroupId))
      .limit(1);
    if (group == null) return null;
    updated.push(group.updatedAt);
    rows = await db
      .select(columns)
      .from(tariffs)
      .where(eq(tariffs.pricingGroupId, mapping.pricingGroupId));
  } else {
    return null;
  }
  updated.push(...rows.map((r) => r.updatedAt));

  const sources: TariffSource[] = rows.map((r) => ({
    ...r,
    restrictions: r.restrictions as TariffRestrictions | null,
  }));
  const applyRestrictions = mapping.pricingGroupId != null;

  let holidays: string[] = [];
  if (applyRestrictions && sources.some((s) => s.restrictions?.holidays === true)) {
    const holidayRows = await db
      .select({ date: pricingHolidays.date, createdAt: pricingHolidays.createdAt })
      .from(pricingHolidays);
    holidays = holidayRows.map((h) => toIsoDate(h.date));
    updated.push(...holidayRows.map((h) => h.createdAt));
  }

  return transformTariff(
    {
      tariffs: sources,
      applyRestrictions,
      holidays,
      today: now.toISOString().slice(0, 10),
      currency: await getCompanyCurrency(),
      taxBasis: await getCompanyTaxBasis(),
      countryCode: config.OCPI_COUNTRY_CODE,
      partyId: config.OCPI_PARTY_ID,
      ocpiTariffId: mapping.ocpiTariffId,
      lastUpdated: latest(updated),
    },
    version,
  );
}

/** Every tariff a partner sees, rendered in a version, newest first. */
export async function renderPartnerTariffs(
  partnerId: string,
  version: OcpiVersion,
  now: Date = new Date(),
): Promise<PublishedTariff[]> {
  const mappings = await partnerTariffMappings(partnerId);
  const rendered = await Promise.all(mappings.map((m) => renderTariffMapping(m, version, now)));
  return rendered
    .filter((t): t is PublishedTariff => t != null)
    .sort((a, b) => b.last_updated.localeCompare(a.last_updated) || a.id.localeCompare(b.id));
}
