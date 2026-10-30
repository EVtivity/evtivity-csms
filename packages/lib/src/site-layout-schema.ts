// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

// The Zod schema of a site's layout settings (sites.layout_settings): the
// paved lot and the transformers on the grass. Shared by the API route and the
// tests. The limits and defaults live in @evtivity/lib/site-layout, which the
// CSMS imports without Zod.

import { z } from 'zod';
import { LAYOUT_GRID_LIMITS } from './site-layout.js';

const L = LAYOUT_GRID_LIMITS;

/** Meters with at most one decimal (10 cm steps). */
function meters(min: number, max: number) {
  return z
    .number()
    .min(min)
    .max(max)
    .refine((v) => Math.abs(v * 10 - Math.round(v * 10)) < 1e-9, {
      message: 'At most one decimal (10 cm steps)',
    });
}

const reach = L.transformerReachM + L.spotsPerRow.max * L.spotWidthM.max;

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

export const siteLayoutSettingsSchema = z
  .object({
    spotsPerRow: z
      .number()
      .int()
      .min(L.spotsPerRow.min)
      .max(L.spotsPerRow.max)
      .describe(
        `Parking spots in each row (${String(L.spotsPerRow.min)} to ${String(L.spotsPerRow.max)})`,
      ),
    rows: z
      .number()
      .int()
      .min(L.rows.min)
      .max(L.rows.max)
      .describe(`Number of rows (${String(L.rows.min)} to ${String(L.rows.max)})`),
    spotWidthM: meters(L.spotWidthM.min, L.spotWidthM.max).describe(
      `Spot width in meters (${String(L.spotWidthM.min)} to ${String(L.spotWidthM.max)}, 10 cm steps)`,
    ),
    spotDepthM: meters(L.spotDepthM.min, L.spotDepthM.max).describe(
      `Spot depth in meters (${String(L.spotDepthM.min)} to ${String(L.spotDepthM.max)}, 10 cm steps)`,
    ),
    laneWidthM: meters(L.laneWidthM.min, L.laneWidthM.max).describe(
      `Driving lane between two rows in meters (${String(L.laneWidthM.min)} to ${String(L.laneWidthM.max)}, 10 cm steps; 0 puts the rows back to back)`,
    ),
    facingDeg: z
      .union([z.literal(0), z.literal(90), z.literal(180), z.literal(270)])
      .describe(
        'Direction the spots and chargers face, in degrees (0, 90, 180 or 270; 0 is the default)',
      ),
    transformers: z
      .array(layoutTransformerSchema)
      .max(L.transformers.max)
      .refine((list) => new Set(list.map((t) => t.id)).size === list.length, {
        message: 'Transformer ids must be unique',
      })
      .describe(`Transformers on the grass (up to ${String(L.transformers.max)})`),
  })
  .strict()
  .describe('Layout settings of the site: the paved lot and the transformers on the grass');
