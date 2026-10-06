// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { describe, it, expect } from 'vitest';
import { PgDialect } from 'drizzle-orm/pg-core';
import { paymentRecordsAtSites } from '../lib/payment-site-scope.js';

// Building the condition runs no query: the subqueries are rendered to SQL here
// and checked for the joins and site filters that scope payment records.
describe('paymentRecordsAtSites', () => {
  const render = (siteIds: string[]) => new PgDialect().sqlToQuery(paymentRecordsAtSites(siteIds));

  it('scopes session records by session station and fee records by reservation station', () => {
    const { sql, params } = render(['sit_a', 'sit_b']);
    const normalized = sql.replace(/\s+/g, ' ');
    expect(normalized).toContain(
      '"payment_records"."session_id" in (select "charging_sessions"."id" from "charging_sessions" inner join "charging_stations" on "charging_stations"."id" = "charging_sessions"."station_id" where "charging_stations"."site_id" in ($1, $2))',
    );
    expect(normalized).toContain(
      '"payment_records"."reservation_id" in (select "reservations"."id" from "reservations" inner join "charging_stations" on "charging_stations"."id" = "reservations"."station_id" where "charging_stations"."site_id" in ($3, $4))',
    );
    expect(normalized).toContain(' or ');
    expect(params).toEqual(['sit_a', 'sit_b', 'sit_a', 'sit_b']);
  });

  it('binds a single site once per branch', () => {
    const { params } = render(['sit_only']);
    expect(params).toEqual(['sit_only', 'sit_only']);
  });
});
