// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

// Where a tariff applies: its charging type (AC, DC or both) and its site
// availability (every site, or selected sites). Owner decisions 2026-11-13
// (GitHub discussion 64): a tariff is AC, DC or Both (Both, the default,
// keeps the behavior of tariffs written before), and a tariff of a driver or
// fleet pricing group may apply at selected sites only. Pure, browser-safe.

import type { ChargingKind } from './station-data-plan.js';

/** The charging types a tariff can have. */
export const TARIFF_CHARGING_TYPES = ['ac', 'dc', 'both'] as const;
export type TariffChargingType = (typeof TARIFF_CHARGING_TYPES)[number];

/** Site availability of a tariff. */
export const TARIFF_SITE_SCOPES = ['all', 'selected'] as const;
export type TariffSiteScope = (typeof TARIFF_SITE_SCOPES)[number];

/**
 * A tariff's scope. `siteIds` null means every site (site scope `all`);
 * an array means the selected sites only (an empty array matches no site:
 * a tariff whose last selected site was deleted never applies).
 */
export interface TariffScope {
  chargingType?: TariffChargingType | undefined;
  siteIds?: readonly string[] | null | undefined;
}

/**
 * What a price is resolved for: the session's charging kind (null: not known,
 * for example a station-level view or a mixed EVSE whose connector is not
 * named) and the station's site (null: a station without a site).
 */
export interface TariffContext {
  chargingKind?: ChargingKind | null;
  siteId?: string | null;
}

function typeOf(scope: TariffScope): TariffChargingType {
  return scope.chargingType ?? 'both';
}

function sitesOf(scope: TariffScope): readonly string[] | null {
  return scope.siteIds ?? null;
}

/** True when the tariff's site availability is Selected Sites. */
export function isSiteLimited(scope: TariffScope): boolean {
  return sitesOf(scope) != null;
}

/** True when the tariff applies to every charging type at every site (a default can only be such). */
export function isUnscopedTariff(scope: TariffScope): boolean {
  return typeOf(scope) === 'both' && !isSiteLimited(scope);
}

/**
 * Whether the tariff applies in the context. A Both tariff applies to every
 * kind; an AC or DC tariff only when the kind is known and equal (an unknown
 * kind gets the Both tariffs only, owner decision D-E). An All Sites tariff
 * applies everywhere; a Selected Sites tariff only at a known site it lists.
 */
export function tariffAppliesTo(scope: TariffScope, ctx: TariffContext | undefined): boolean {
  const type = typeOf(scope);
  if (type !== 'both' && type !== (ctx?.chargingKind ?? null)) return false;
  const sites = sitesOf(scope);
  if (sites == null) return true;
  const siteId = ctx?.siteId ?? null;
  return siteId != null && sites.includes(siteId);
}

/**
 * How specific a tariff is (owner decision D-A): one point for an AC or DC
 * type, one for Selected Sites. At one priority a more specific match is
 * tried first.
 */
export function tariffSpecificity(scope: TariffScope): number {
  return (typeOf(scope) === 'both' ? 0 : 1) + (isSiteLimited(scope) ? 1 : 0);
}

/**
 * True when `a` wins over `b` (owner decision D-A): at least as specific on
 * both axes (type and site mode) and more specific on one.
 */
export function tariffScopeDominates(a: TariffScope, b: TariffScope): boolean {
  const ta = typeOf(a);
  const tb = typeOf(b);
  const typeLe = ta === tb || tb === 'both';
  const typeLt = ta !== 'both' && tb === 'both';
  const sa = isSiteLimited(a);
  const sb = isSiteLimited(b);
  const siteLe = sa === sb || !sb;
  const siteLt = sa && !sb;
  return typeLe && siteLe && (typeLt || siteLt);
}

/** True when some session could match both scopes (a shared kind and a shared site). */
export function tariffScopesOverlap(a: TariffScope, b: TariffScope): boolean {
  const ta = typeOf(a);
  const tb = typeOf(b);
  if (ta !== 'both' && tb !== 'both' && ta !== tb) return false;
  const sa = sitesOf(a);
  const sb = sitesOf(b);
  if (sa == null || sb == null) return true;
  return sa.some((s) => sb.includes(s));
}

/**
 * True when two tariffs of one priority with overlapping restrictions would
 * be ambiguous (owner decision D-A): their scopes overlap and neither wins.
 * Examples: AC with AC at All Sites, Selected {A, B} with Selected {B, C},
 * AC at All Sites with Both at Selected Sites. AC never overlaps DC.
 */
export function tariffScopesConflict(a: TariffScope, b: TariffScope): boolean {
  return tariffScopesOverlap(a, b) && !tariffScopeDominates(a, b) && !tariffScopeDominates(b, a);
}

/**
 * The charging kinds a price must be shown for when the kind is not known:
 * the kinds the station's EVSEs have (a mixed EVSE counts for both).
 */
export function chargingKindsOf(kinds: readonly (ChargingKind | 'mixed' | null)[]): ChargingKind[] {
  const out = new Set<ChargingKind>();
  for (const k of kinds) {
    if (k === 'mixed') {
      out.add('ac');
      out.add('dc');
    } else if (k != null) out.add(k);
  }
  return (['ac', 'dc'] as const).filter((k) => out.has(k));
}

/**
 * OCPI publishing of a group whose tariffs differ by charging type (owner
 * decision D-C): one tariff per kind under `<mapped id>-AC` and
 * `<mapped id>-DC`. OCPI Tariff `id` is string(36), so the mapped id of such
 * a group holds at most 33 characters.
 */
export const OCPI_KIND_TARIFF_BASE_ID_MAX = 33;

/** The OCPI tariff id of one charging kind of a mapped group. */
export function ocpiKindTariffId(baseId: string, kind: ChargingKind): string {
  return `${baseId}-${kind === 'ac' ? 'AC' : 'DC'}`;
}

/** True when tariffs differ by charging type (any AC or DC tariff among them). */
export function hasChargingTypeTariffs(tariffs: readonly TariffScope[]): boolean {
  return tariffs.some((t) => typeOf(t) !== 'both');
}
