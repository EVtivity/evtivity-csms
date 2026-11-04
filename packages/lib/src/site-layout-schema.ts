// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

// The Zod schema of a site's layout settings (sites.layout_settings): the
// site type, the paved lot, and the positions of the site's transformers and
// energy assets (batteries and solar canopies) by the id of their load
// management rows, which hold their names and ratings. Shared by the API route and the
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

// Every coordinate a position may hold: a transformer or battery on the grass
// of a lot or a depot, or equipment standing freely on a custom site.
const equipmentReach = Math.max(reach, FREE_LAYOUT.reachM);
const equipmentCoordinate = z.number().min(-equipmentReach).max(equipmentReach);
const equipmentId = (table: string) =>
  z
    .string()
    .regex(/^[A-Za-z0-9_-]{1,40}$/)
    .describe(
      `The ${table}.id of the equipment, a row of this site (1 to 40 letters, digits, - or _); its name and ratings live in that table`,
    );

export const layoutTransformerSchema = z
  .object({
    id: equipmentId('transformers'),
    x: equipmentCoordinate.describe(
      'Position in meters along the rows, from the front left corner of the lot (a custom site: from the site origin). A point on the lot moves to the grass beside it',
    ),
    z: equipmentCoordinate.describe(
      'Position in meters across the rows, from the front left corner of the lot',
    ),
  })
  .strict()
  .describe(
    'Where a transformer of the site stands: a pad-mounted transformer on the grass next to the lot. Position only; the transformer is a load management row (GET /v1/sites/{siteId}/transformers)',
  );

const freeCoordinate = z.number().min(-FREE_LAYOUT.reachM).max(FREE_LAYOUT.reachM);
const rotationDeg = z.number().min(0).max(359.9);

export const layoutEnergyAssetSchema = z
  .object({
    id: equipmentId('site_energy_assets'),
    x: equipmentCoordinate
      .optional()
      .describe(
        'Battery: position in meters along the rows, from the front left corner of the lot (a point on the lot moves to the grass beside it). Solar canopy on a custom site or a depot: the middle of the canopy. Absent: the default place of its type',
      ),
    z: equipmentCoordinate
      .optional()
      .describe('Battery or free-standing solar canopy: position in meters across the rows'),
    row: z
      .number()
      .int()
      .min(0)
      .max(L.rows.max - 1)
      .optional()
      .describe(
        "Solar canopy on a parking lot: the 0-based row it covers; a row past the lot's last row reads as the last row. Absent: the first row without a canopy",
      ),
    rotationDeg: rotationDeg
      .optional()
      .describe(
        'Solar canopy on a custom site or a depot: the turn in degrees, clockwise from above',
      ),
  })
  .strict()
  .refine((a) => (a.x == null) === (a.z == null), {
    message: 'x and z go together',
    path: ['z'],
  })
  .describe(
    'Where a battery or solar canopy of the site stands. Position only; its type, name and ratings are a load management row (GET /v1/sites/{siteId}/energy-assets)',
  );

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
        `Parking lot, depot and custom site: positions of the site's transformers by id (up to ${String(L.transformers.max)}). Every id names a transformer of the site (else 400 VALIDATION_ERROR); a transformer without a position stands at its default place`,
      ),
    energyAssets: z
      .array(layoutEnergyAssetSchema)
      .max(L.energyAssets.max)
      .refine((list) => new Set(list.map((a) => a.id)).size === list.length, {
        message: 'Energy asset ids must be unique',
      })
      .optional()
      .describe(
        `Parking lot, depot and custom site: positions of the site's batteries and solar canopies by id (up to ${String(L.energyAssets.max)}). Every id names an energy asset of the site (else 400 VALIDATION_ERROR); an asset without a position stands at the default place of its type. Absent means none`,
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
