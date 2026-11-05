// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { describe, it, expect } from 'vitest';
import { PgDialect } from 'drizzle-orm/pg-core';
import {
  publicSiteListed,
  publicStationListed,
  publicStationServed,
  qrCheckableStation,
} from '../lib/public-station.js';

// Building the condition runs no query: it is rendered to SQL here.
const toQuery = (condition: ReturnType<typeof publicStationServed>) =>
  new PgDialect().sqlToQuery(condition);
const render = (condition: ReturnType<typeof publicStationServed>) =>
  toQuery(condition).sql.replace(/\s+/g, ' ');

describe('publicStationServed', () => {
  it('serves accepted operator stations only, never a conformance station', () => {
    const text = render(publicStationServed());
    expect(text).toContain('"charging_stations"."onboarding_status" = $1');
    expect(text).toContain('"charging_stations"."is_conformance" = $2');
    expect(toQuery(publicStationServed()).params).toEqual(['accepted', false]);
  });

  it('serves a station taken out of the portal listings', () => {
    expect(render(publicStationServed())).not.toContain('portal_listed');
  });
});

describe('publicStationListed', () => {
  it('lists served stations the operator did not take out of the listings', () => {
    const text = render(publicStationListed());
    expect(text).toContain('"charging_stations"."onboarding_status" = $1');
    expect(text).toContain('"charging_stations"."is_conformance" = $2');
    expect(text).toContain('"charging_stations"."portal_listed" = $3');
    expect(toQuery(publicStationListed()).params).toEqual(['accepted', false, true]);
  });
});

describe('publicSiteListed', () => {
  it('lists a site only through a station the listings show', () => {
    const text = render(publicSiteListed());
    expect(text).toContain('EXISTS (SELECT 1 FROM "charging_stations"');
    expect(text).toContain('"charging_stations"."is_conformance" = $2');
    expect(text).toContain('"charging_stations"."portal_listed" = $3');
  });
});

describe('qrCheckableStation', () => {
  it('checks served operator stations and accepted conformance stations only', () => {
    const query = toQuery(qrCheckableStation());
    const text = query.sql.replace(/\s+/g, ' ');
    expect(text).toContain('"charging_stations"."onboarding_status" = $1');
    expect(text).toContain('"charging_stations"."is_conformance" = $2');
    expect(text).toContain(' or ');
    expect(text).toContain('not "charging_stations"."is_conformance" = $4');
    expect(text).not.toContain('portal_listed');
    expect(query.params).toEqual(['accepted', false, 'accepted', false]);
  });
});
