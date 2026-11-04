// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

// The site type labels and the one-line layout summary the site Details tab
// shows (the Layout tab's Site Settings show the type read-only).

import type { TFunction } from 'i18next';
import {
  chargerMountingOf,
  chargerPlacementOf,
  showsTransformers,
  siteTypeOf,
  type ChargerPlacement,
  type PlacedLayoutSettings,
  type SiteType,
} from '@evtivity/lib/site-layout';

export const SITE_TYPE_LABEL = {
  parking_lot: 'sites.layoutSettings.siteTypeParkingLot',
  office_retail: 'sites.layoutSettings.siteTypeOfficeRetail',
  curbside: 'sites.layoutSettings.siteTypeCurbside',
  depot: 'sites.layoutSettings.siteTypeDepot',
  custom: 'sites.layoutSettings.siteTypeCustom',
} as const satisfies Record<SiteType, string>;

export const CHARGER_PLACEMENT_LABEL = {
  islands: 'sites.layoutSettings.chargerPlacementIslands',
  lot_edge: 'sites.layoutSettings.chargerPlacementLotEdge',
} as const satisfies Record<ChargerPlacement, string>;

/**
 * The layout in one line, from the effective settings with the site's
 * power equipment joined (`placePowerEquipment`, so a transformer counts
 * whether or not it has a stored position): "Parking Lot, 2 x 10
 * spots, 2 transformers", "Office or Retail, 12 wall chargers", "Office or
 * Retail, 6 chargers on posts", "Curbside, 4 + 6 chargers", "Depot, 6 bus bays,
 * 3 truck lanes", "Custom, stations placed freely, 1 transformer".
 */
export function layoutSummary(t: TFunction, settings: PlacedLayoutSettings): string {
  switch (siteTypeOf(settings)) {
    case 'office_retail':
      return chargerMountingOf(settings) === 'wall'
        ? t('sites.layoutSummary.officeWall', { count: settings.chargers ?? 1 })
        : t('sites.layoutSummary.officeStall', { count: settings.chargers ?? 1 });
    case 'curbside':
      return t('sites.layoutSummary.curbside', {
        left: settings.chargersLeft ?? 0,
        right: settings.chargersRight ?? 0,
      });
    case 'depot':
      return t('sites.layoutSummary.depot', {
        bays: t('sites.layoutSummary.busBays', { count: settings.busBays ?? 1 }),
        lanes: t('sites.layoutSummary.truckLanes', { count: settings.truckLanes ?? 0 }),
      });
    case 'custom':
      return settings.transformers.length > 0
        ? t('sites.layoutSummary.customTransformers', { count: settings.transformers.length })
        : t('sites.layoutSummary.custom');
    default: {
      const transformers = showsTransformers(settings) ? settings.transformers.length : 0;
      const grid = { rows: settings.rows, spots: settings.spotsPerRow };
      const summary =
        transformers > 0
          ? t('sites.layoutSummary.parkingLotTransformers', { ...grid, count: transformers })
          : t('sites.layoutSummary.parkingLot', grid);
      return chargerPlacementOf(settings) === 'lot_edge'
        ? t('sites.layoutSummary.lotEdge', { summary })
        : summary;
    }
  }
}
