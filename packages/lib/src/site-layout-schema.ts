// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

// The Zod schema of a site's layout settings (sites.layout_settings): the
// site type, the paved lot, the transformers on the grass and the energy
// assets (batteries and solar canopies). Shared by the API route and the
// tests. The limits and defaults live in @evtivity/lib/site-layout, which the
// CSMS imports without Zod.

import { z } from 'zod';
import {
  CHARGER_MOUNTINGS,
  CHARGER_PLACEMENTS,
  DEPOT_LAYOUT,
  FREE_LAYOUT,
  FREE_SPOT_DIMENSIONS,
  LAYOUT_GRID_LIMITS,
  SITE_TYPES,
  STANDARD_DIMENSIONS,
} from './site-layout.js';

const L = LAYOUT_GRID_LIMITS;

// The farthest a lot or a depot yard reaches from its origin, plus the transformer reach.
const D = DEPOT_LAYOUT;
// The drive lane of a yard with truck lanes is the wider one (`depotDriveLaneM`).
const depotExtent =
  Math.max(
    L.depotSpots.max * FREE_SPOT_DIMENSIONS.bus_bay.widthM +
      D.medianM +
      2 * D.truckRoadM +
      FREE_SPOT_DIMENSIONS.truck_pull_through.lengthM,
    L.depotSpots.max * (FREE_SPOT_DIMENSIONS.truck_pull_through.widthM + FREE_LAYOUT.truckIslandM),
  ) +
  D.driveLaneM +
  2 * D.marginM;
const reach =
  L.transformerReachM + Math.max(L.spotsPerRow.max * STANDARD_DIMENSIONS.spotWidthM, depotExtent);

export const layoutTransformerSchema = z
  .object({
    id: z
      .string()
      .regex(/^[A-Za-z0-9_-]{1,40}$/)
      .describe('Id of the transformer within the site (1 to 40 letters, digits, - or _)'),
    name: z
      .string()
      .trim()
      .min(1)
      .max(L.transformerNameLength)
      .nullable()
      .describe(`Name shown on the layout (up to ${String(L.transformerNameLength)} characters)`),
    ratedKva: z
      .number()
      .int()
      .min(L.ratedKva.min)
      .max(L.ratedKva.max)
      .nullable()
      .describe('Rated power in kVA'),
    x: z
      .number()
      .min(-reach)
      .max(reach)
      .describe(
        'Position in meters along the rows, from the front left corner of the lot. A point on the lot moves to the grass beside it',
      ),
    z: z
      .number()
      .min(-reach)
      .max(reach)
      .describe('Position in meters across the rows, from the front left corner of the lot'),
  })
  .strict()
  .describe('A pad-mounted transformer on the grass next to the lot');

const assetId = z
  .string()
  .regex(/^[A-Za-z0-9_-]{1,40}$/)
  .describe('Id of the energy asset within the site (1 to 40 letters, digits, - or _)');
const assetName = z
  .string()
  .trim()
  .min(1)
  .max(L.energyAssetNameLength)
  .nullable()
  .describe(`Name shown on the layout (up to ${String(L.energyAssetNameLength)} characters)`);
const capacity = (unit: string) =>
  z
    .number()
    .int()
    .min(L.capacity.min)
    .max(L.capacity.max)
    .nullable()
    .describe(`${unit} (${String(L.capacity.min)} to ${String(L.capacity.max)}), informational`);

export const layoutBatterySchema = z
  .object({
    id: assetId,
    type: z.literal('battery').describe('A battery storage cabinet on the grass'),
    name: assetName,
    capacityKwh: capacity('Usable capacity in kWh'),
    x: z
      .number()
      .min(-reach)
      .max(reach)
      .describe(
        'Position in meters along the rows, from the front left corner of the lot. A point on the lot moves to the grass beside it, like a transformer',
      ),
    z: z
      .number()
      .min(-reach)
      .max(reach)
      .describe('Position in meters across the rows, from the front left corner of the lot'),
  })
  .strict()
  .describe(
    'A battery storage cabinet on the grass next to the lot or the depot yard (standing freely on a custom site), shown on a parking lot, a depot and a custom site (kept, hidden, on the other site types)',
  );

const freeCoordinate = z.number().min(-FREE_LAYOUT.reachM).max(FREE_LAYOUT.reachM);
const rotationDeg = z.number().min(0).max(359.9);

/** A station's free position on a custom site (the layout GET and PUT). */
export const freePlacementSchema = z
  .object({
    x: freeCoordinate.describe(
      `Meters along the site x axis (${String(-FREE_LAYOUT.reachM)} to ${String(FREE_LAYOUT.reachM)})`,
    ),
    z: freeCoordinate.describe(
      `Meters along the site z axis (${String(-FREE_LAYOUT.reachM)} to ${String(FREE_LAYOUT.reachM)})`,
    ),
    rotationDeg: rotationDeg.describe(
      'Turn in degrees, clockwise from above (0 to 359.9; 0: the parking spots lie toward +z)',
    ),
  })
  .strict()
  .describe(
    'Position of the station on a custom site: the charger point in meters and its turn; its car spots (one per EVSE, at most two) lie in front of it',
  );

export const layoutSolarCanopySchema = z
  .object({
    id: assetId,
    type: z.literal('solar').describe('A solar carport canopy over one row of the lot'),
    name: assetName,
    capacityKwp: capacity('Peak power in kWp'),
    row: z
      .number()
      .int()
      .min(0)
      .max(L.rows.max - 1)
      .describe(
        "0-based row of the lot the canopy covers; a row past the lot's last row reads as the last row",
      ),
    x: freeCoordinate
      .optional()
      .describe(
        'Custom site and depot: the middle of the canopy in meters along x. Absent: over its row of the parking lot grid (a depot: over staff parking behind the yard)',
      ),
    z: freeCoordinate
      .optional()
      .describe('Custom site and depot: the middle of the canopy in meters along z'),
    rotationDeg: rotationDeg
      .optional()
      .describe('Custom site and depot: the turn of the canopy in degrees, clockwise from above'),
  })
  .strict()
  .describe(
    'A solar carport canopy: over a row of the lot on a parking lot, standing freely on a custom site or a depot (its length follows its peak power); kept, hidden, on the other site types',
  );

export const layoutEnergyAssetSchema = z
  .discriminatedUnion('type', [layoutBatterySchema, layoutSolarCanopySchema])
  .describe('An informational energy asset: a battery or a solar canopy');

export const siteLayoutSettingsSchema = z
  .object({
    siteType: z
      .enum(SITE_TYPES)
      .optional()
      .describe(
        'Kind of site: parking_lot (an outdoor hub: a paved lot on grass with transformers, batteries, solar canopies and switchboards), office_retail (one row of spots in front of a building, chargers on the facade or on a post at each spot), curbside (a street with chargers on posts at the curb of one or both sides), depot (a paved fleet yard: nose-in bus bays of 4.3 by 14 m with pantograph poles or dispensers at their heads, and truck pull-through lanes of 5 by 25 m with a dispenser island beside each, one station per bay or lane) or custom (grass with each station placed and turned freely, with its own car spots). Only a parking lot, a depot and a custom site show transformers, energy assets and load management panels; the other types keep them stored, hidden. Absent means parking_lot',
      ),
    spotsPerRow: z
      .number()
      .int()
      .min(L.spotsPerRow.min)
      .max(L.spotsPerRow.max)
      .describe(
        `Parking lot: spots in each row (${String(L.spotsPerRow.min)} to ${String(L.spotsPerRow.max)})`,
      ),
    rows: z
      .number()
      .int()
      .min(L.rows.min)
      .max(L.rows.max)
      .describe(`Parking lot: number of rows (${String(L.rows.min)} to ${String(L.rows.max)})`),
    facingDeg: z
      .union([z.literal(0), z.literal(90), z.literal(180), z.literal(270)])
      .describe(
        'Parking lot and depot: direction the spots and chargers face, in degrees (0, 90, 180 or 270; 0 is the default)',
      ),
    chargers: z
      .number()
      .int()
      .min(L.chargers.min)
      .max(L.chargers.max)
      .optional()
      .describe(
        `Office or retail: charger positions, one spot each, in one row along the building (${String(L.chargers.min)} to ${String(L.chargers.max)}). Absent means one per station at the site`,
      ),
    mounting: z
      .enum(CHARGER_MOUNTINGS)
      .optional()
      .describe(
        'Office or retail: wall (a wall box on the facade, its cable across the sidewalk) or stall (a post at the head of each spot). Absent means wall',
      ),
    chargerPlacement: z
      .enum(CHARGER_PLACEMENTS)
      .optional()
      .describe(
        'Parking lot only: islands (chargers on the islands of rows back to back and at the lot edge rows, every row charges) or lot_edge (chargers only along the lot edge: the first and the last row, the inner rows ordinary parking). Absent means islands; refused on the other site types',
      ),
    chargersLeft: z
      .number()
      .int()
      .min(L.chargersPerSide.min)
      .max(L.chargersPerSide.max)
      .optional()
      .describe(
        `Curbside: chargers along the left curb (${String(L.chargersPerSide.min)} to ${String(L.chargersPerSide.max)}; both sides together at least 1). Absent means half the stations at the site, rounded up`,
      ),
    chargersRight: z
      .number()
      .int()
      .min(L.chargersPerSide.min)
      .max(L.chargersPerSide.max)
      .optional()
      .describe(
        `Curbside: chargers along the right curb (${String(L.chargersPerSide.min)} to ${String(L.chargersPerSide.max)}). Absent means the stations the left curb leaves`,
      ),
    busBays: z
      .number()
      .int()
      .min(L.depotSpots.min)
      .max(L.depotSpots.max)
      .optional()
      .describe(
        `Depot: nose-in bus bays, one station each (${String(L.depotSpots.min)} to ${String(L.depotSpots.max)}; bus bays and truck lanes together at least 1). Absent means one per station at the site without a Megawatt Charging System connector`,
      ),
    truckLanes: z
      .number()
      .int()
      .min(L.depotSpots.min)
      .max(L.depotSpots.max)
      .optional()
      .describe(
        `Depot: truck pull-through lanes, one station each (${String(L.depotSpots.min)} to ${String(L.depotSpots.max)}). Absent means one per station at the site with a Megawatt Charging System connector (MCS, cMCS)`,
      ),
    transformers: z
      .array(layoutTransformerSchema)
      .max(L.transformers.max)
      .refine((list) => new Set(list.map((t) => t.id)).size === list.length, {
        message: 'Transformer ids must be unique',
      })
      .describe(
        `Parking lot, depot and custom site: transformers on the grass (up to ${String(L.transformers.max)}), information only`,
      ),
    energyAssets: z
      .array(layoutEnergyAssetSchema)
      .max(L.energyAssets.max)
      .refine((list) => new Set(list.map((a) => a.id)).size === list.length, {
        message: 'Energy asset ids must be unique',
      })
      .optional()
      .describe(
        `Parking lot, depot and custom site: batteries and solar canopies, informational (up to ${String(L.energyAssets.max)}). Absent means none`,
      ),
  })
  .strict()
  .refine((s) => s.chargersLeft !== 0 || s.chargersRight !== 0, {
    message: 'A curbside site needs at least one charger on one side',
    path: ['chargersRight'],
  })
  .refine((s) => s.chargerPlacement == null || (s.siteType ?? 'parking_lot') === 'parking_lot', {
    message: 'Charger placement is a parking lot setting',
    path: ['chargerPlacement'],
  })
  .refine((s) => s.busBays !== 0 || s.truckLanes !== 0, {
    message: 'A depot needs at least one bus bay or truck lane',
    path: ['truckLanes'],
  })
  .describe(
    'Layout settings of the site: the site type and the fields of every type (kept when the type changes, so switching back restores them). Spot sizes are standard (2.6 by 5.5 m spots, a 7 m drive aisle, 2.4 by 6 m parallel spots), not settings',
  );
