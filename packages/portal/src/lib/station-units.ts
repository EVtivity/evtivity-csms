// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

/**
 * The query of a charger page link: `?unit=<id>` for one unit (charger box)
 * of a station with units, nothing for a whole station.
 */
export function chargerUnitQuery(unitId: string | null | undefined): string {
  return unitId != null ? `?unit=${encodeURIComponent(unitId)}` : '';
}

/** The React key of a charger row: several rows can share a station. */
export function chargerRowKey(stationId: string, unitId: string | null | undefined): string {
  return `${stationId}#${unitId ?? ''}`;
}
