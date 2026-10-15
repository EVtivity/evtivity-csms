// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { describe, it, expect } from 'vitest';
import { PgDialect } from 'drizzle-orm/pg-core';
import { publicSiteListed, publicStationListed } from '../lib/public-station.js';

// Building the condition runs no query: it is rendered to SQL here.
const render = (condition: ReturnType<typeof publicStationListed>) =>
  new PgDialect().sqlToQuery(condition).sql.replace(/\s+/g, ' ');

describe('publicStationListed', () => {
  it('serves accepted operator stations only, never a conformance station', () => {
    const text = render(publicStationListed());
    expect(text).toContain('"charging_stations"."onboarding_status" = $1');
    expect(text).toContain('"charging_stations"."is_conformance" = $2');
    expect(new PgDialect().sqlToQuery(publicStationListed()).params).toEqual(['accepted', false]);
  });
});

describe('publicSiteListed', () => {
  it('lists a site only through a station the portal serves', () => {
    const text = render(publicSiteListed());
    expect(text).toContain('EXISTS (SELECT 1 FROM "charging_stations"');
    expect(text).toContain('"charging_stations"."is_conformance" = $2');
  });
});
