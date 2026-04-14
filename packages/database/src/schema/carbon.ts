// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { pgTable, serial, varchar, numeric, timestamp, index } from 'drizzle-orm/pg-core';

export const carbonIntensityFactors = pgTable(
  'carbon_intensity_factors',
  {
    id: serial('id').primaryKey(),
    regionCode: varchar('region_code', { length: 20 }).notNull().unique(),
    regionName: varchar('region_name', { length: 255 }).notNull(),
    countryCode: varchar('country_code', { length: 2 }).notNull(),
    carbonIntensityKgPerKwh: numeric('carbon_intensity_kg_per_kwh').notNull(),
    source: varchar('source', { length: 100 }).notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [index('idx_carbon_factors_country_code').on(table.countryCode)],
);
