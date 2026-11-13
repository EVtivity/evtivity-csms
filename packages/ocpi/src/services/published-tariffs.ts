// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

// Published OCPI tariffs. An `ocpi_tariff_mappings` row names the OCPI tariff
// id a partner sees and the internal tariff or pricing group it is generated
// from. Every GET, push, and CDR renders the tariff from that source with
// `transformTariff`, so prices, tax, and currency are the ones billed.

import { eq, inArray, isNull, max, or } from 'drizzle-orm';
import {
  db,
  holidayAuditLog,
  ocpiTariffMappings,
  pricingGroups,
  pricingHolidays,
  settings,
  tariffs,
  getCompanyCurrency,
  getCompanyTaxBasis,
  getIdlingGracePeriodMinutes,
} from '@evtivity/database';
import { OCPI_TARIFF_SETTING_KEYS, ocpiKindTariffId, tariffAppliesTo } from '@evtivity/lib';
import type { ChargingKind, TariffRestrictions } from '@evtivity/lib';
import { config } from '../lib/config.js';
import { transformTariff } from '../transformers/tariff.transformer.js';
import type { TariffSource } from '../transformers/tariff.transformer.js';
import type { OcpiTariff, OcpiVersion } from '../types/ocpi.js';
import type { TaxBasis } from '@evtivity/lib/price-display';
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

/** An OCPI tariff id a mapping publishes, and the charging kind it holds (null: every kind). */
export interface PublishedTariffId {
  id: string;
  kind: ChargingKind | null;
}

/**
 * The OCPI tariff ids a mapping publishes (owner decision D-C, 2026-11-13):
 * a pricing group whose active tariffs differ by charging type is published
 * as `<id>-AC` (its AC and Both tariffs) and `<id>-DC` (its DC and Both
 * tariffs); every other mapping as its own id.
 */
export async function mappingPublishedIds(mapping: TariffMappingRow): Promise<PublishedTariffId[]> {
  if (mapping.pricingGroupId == null) return [{ id: mapping.ocpiTariffId, kind: null }];
  const rows = await db
    .select({ chargingType: tariffs.chargingType, isActive: tariffs.isActive })
    .from(tariffs)
    .where(eq(tariffs.pricingGroupId, mapping.pricingGroupId));
  if (!rows.some((r) => r.isActive && r.chargingType !== 'both')) {
    return [{ id: mapping.ocpiTariffId, kind: null }];
  }
  return [
    { id: ocpiKindTariffId(mapping.ocpiTariffId, 'ac'), kind: 'ac' },
    { id: ocpiKindTariffId(mapping.ocpiTariffId, 'dc'), kind: 'dc' },
  ];
}

/**
 * Every id a push of a mapping must refresh: its own id and, for a pricing
 * group, the per-kind ids, so a group that starts or stops differing by
 * charging type deletes the ids it no longer publishes.
 */
export function mappingPushIds(mapping: TariffMappingRow): string[] {
  if (mapping.pricingGroupId == null) return [mapping.ocpiTariffId];
  return [
    mapping.ocpiTariffId,
    ocpiKindTariffId(mapping.ocpiTariffId, 'ac'),
    ocpiKindTariffId(mapping.ocpiTariffId, 'dc'),
  ];
}

/** The mapping a partner's published OCPI tariff id comes from, with its kind. */
export async function findPublishedTariff(
  partnerId: string,
  ocpiTariffId: string,
): Promise<{ mapping: TariffMappingRow; kind: ChargingKind | null } | null> {
  for (const mapping of await partnerTariffMappings(partnerId)) {
    const published = (await mappingPublishedIds(mapping)).find((p) => p.id === ocpiTariffId);
    if (published != null) return { mapping, kind: published.kind };
  }
  return null;
}

/**
 * The OCPI id a CDR names a session tariff under: the mapping's own id, or
 * for a pricing group published per kind (D-C) the id of the tariff's kind,
 * and for a Both tariff the session's kind (AC when not known: the Both
 * tariffs are part of both per-kind tariffs).
 */
export async function sessionPublishedTariffId(
  mapping: TariffMappingRow,
  tariffId: string,
  sessionKind: string | null,
): Promise<string> {
  const ids = await mappingPublishedIds(mapping);
  if (ids.length === 1) return ids[0]?.id ?? mapping.ocpiTariffId;
  const [row] = await db
    .select({ chargingType: tariffs.chargingType })
    .from(tariffs)
    .where(eq(tariffs.id, tariffId))
    .limit(1);
  const type = row?.chargingType;
  const kind: ChargingKind =
    type === 'ac' || type === 'dc' ? type : sessionKind === 'dc' ? 'dc' : 'ac';
  return ids.find((i) => i.kind === kind)?.id ?? mapping.ocpiTariffId;
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
 * The last change of a setting every published tariff is rendered with
 * (`OCPI_TARIFF_SETTING_KEYS`: currency, tax basis, idle grace). It changes
 * every published tariff, so it moves `last_updated`.
 */
async function tariffSettingsUpdatedAt(): Promise<Date | null> {
  const [row] = await db
    .select({ updatedAt: max(settings.updatedAt) })
    .from(settings)
    .where(inArray(settings.key, [...OCPI_TARIFF_SETTING_KEYS]));
  return row?.updatedAt ?? null;
}

/** The last holiday change, a deleted holiday included (its audit row). */
async function holidaysUpdatedAt(): Promise<Date | null> {
  const [row] = await db
    .select({ updatedAt: max(holidayAuditLog.createdAt) })
    .from(holidayAuditLog);
  return row?.updatedAt ?? null;
}

/** UTC-12, the last timezone to reach a date. */
const LAST_TIMEZONE_OFFSET_MS = 12 * 3_600_000;

/**
 * The day past holidays and date ranges are left out from: the date in the
 * last timezone to reach it (UTC-12). A published tariff is not tied to one
 * site, and partners apply its dates in each Location's time_zone, so a
 * holiday stays published until it has ended at every site. With the UTC date
 * a holiday disappeared while it still applied at a site west of UTC.
 */
export function publishedToday(now: Date): string {
  return new Date(now.getTime() - LAST_TIMEZONE_OFFSET_MS).toISOString().slice(0, 10);
}

/**
 * A mapping rendered as the OCPI Tariff of a version, in the company
 * currency. Null when its source no longer exists.
 */
export async function renderTariffMapping(
  mapping: TariffMappingRow,
  version: OcpiVersion,
  now: Date = new Date(),
  /** The per-kind tariff of a group that differs by charging type (D-C). */
  published: PublishedTariffId = { id: mapping.ocpiTariffId, kind: null },
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
    chargingType: tariffs.chargingType,
    siteScope: tariffs.siteScope,
    updatedAt: tariffs.updatedAt,
  };

  let rows: Array<
    Omit<TariffSource, 'restrictions'> & {
      restrictions: unknown;
      updatedAt: Date;
      chargingType: string;
      siteScope: string;
    }
  >;
  const updated: Date[] = [mapping.updatedAt];
  if (mapping.tariffId != null) {
    rows = await db.select(columns).from(tariffs).where(eq(tariffs.id, mapping.tariffId));
    // An inactive tariff is not billed, so it is not published either: the
    // push DELETEs it at the partner and GET /cpo/tariffs leaves it out.
    if (rows.length === 0 || rows.every((r) => !r.isActive)) return null;
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

  // A Selected Sites tariff prices drivers and fleets of the CSMS only, never
  // a roaming session, so it is not published. A per-kind tariff (D-C) holds
  // the tariffs of its kind and the Both tariffs.
  const sources: TariffSource[] = rows
    .filter(
      (r) =>
        r.siteScope !== 'selected' &&
        (mapping.pricingGroupId == null ||
          tariffAppliesTo(
            {
              chargingType:
                r.chargingType === 'ac' || r.chargingType === 'dc' ? r.chargingType : 'both',
            },
            { chargingKind: published.kind },
          )),
    )
    .map((r) => ({
      ...r,
      restrictions: r.restrictions as TariffRestrictions | null,
    }));
  if (sources.length === 0) return null;
  const applyRestrictions = mapping.pricingGroupId != null;

  let holidays: string[] = [];
  if (applyRestrictions && sources.some((s) => s.restrictions?.holidays === true)) {
    const holidayRows = await db
      .select({ date: pricingHolidays.date, createdAt: pricingHolidays.createdAt })
      .from(pricingHolidays);
    holidays = holidayRows.map((h) => toIsoDate(h.date));
    updated.push(...holidayRows.map((h) => h.createdAt));
    const holidayChange = await holidaysUpdatedAt();
    if (holidayChange != null) updated.push(holidayChange);
  }
  const settingsChange = await tariffSettingsUpdatedAt();
  if (settingsChange != null) updated.push(settingsChange);

  return transformTariff(
    {
      tariffs: sources,
      applyRestrictions,
      holidays,
      today: publishedToday(now),
      currency: await getCompanyCurrency(),
      taxBasis: await getCompanyTaxBasis(),
      graceMinutes: await getIdlingGracePeriodMinutes(),
      countryCode: config.OCPI_COUNTRY_CODE,
      partyId: config.OCPI_PARTY_ID,
      ocpiTariffId: published.id,
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
  const rendered = (
    await Promise.all(
      mappings.map(async (m) =>
        Promise.all(
          (await mappingPublishedIds(m)).map((p) => renderTariffMapping(m, version, now, p)),
        ),
      ),
    )
  ).flat();
  return rendered
    .filter((t): t is PublishedTariff => t != null)
    .sort((a, b) => b.last_updated.localeCompare(a.last_updated) || a.id.localeCompare(b.id));
}

/**
 * A tariff as one session was billed with it (its price snapshot), rendered
 * as an OCPI Tariff for the session's CDR: without restrictions (the CDR's
 * charging periods name the tariff of each part), in the session's currency
 * and tax basis, with the idle grace. The prices are the ones charged, not the
 * tariff's current ones.
 */
export async function renderSnapshotTariff(
  input: {
    prices: TariffSource;
    ocpiTariffId: string;
    currency: string;
    taxBasis: TaxBasis | null;
    lastUpdated: Date;
  },
  version: OcpiVersion,
): Promise<PublishedTariff> {
  return transformTariff(
    {
      tariffs: [input.prices],
      applyRestrictions: false,
      holidays: [],
      today: publishedToday(input.lastUpdated),
      currency: input.currency,
      taxBasis: input.taxBasis ?? (await getCompanyTaxBasis()),
      graceMinutes: await getIdlingGracePeriodMinutes(),
      countryCode: config.OCPI_COUNTRY_CODE,
      partyId: config.OCPI_PARTY_ID,
      ocpiTariffId: input.ocpiTariffId,
      lastUpdated: input.lastUpdated,
    },
    version,
  );
}
