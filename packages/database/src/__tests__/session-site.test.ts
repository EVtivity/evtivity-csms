// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { describe, expect, it } from 'vitest';
import { sql } from 'drizzle-orm';
import { PgDialect } from 'drizzle-orm/pg-core';
import type postgres from 'postgres';
import { sessionSiteIdSql } from '../lib/session-site.js';

describe('sessionSiteIdSql', () => {
  it('builds the station site sub-select with drizzle sql', () => {
    const query = new PgDialect().sqlToQuery(sessionSiteIdSql(sql, 'sta_1'));
    expect(query.sql).toBe('(SELECT site_id FROM charging_stations WHERE id = $1)');
    expect(query.params).toEqual(['sta_1']);
  });

  it('calls a postgres.js tag with the same template and the station id', () => {
    const calls: Array<{ text: string; values: unknown[] }> = [];
    const tag = ((strings: TemplateStringsArray, ...values: unknown[]) => {
      calls.push({ text: strings.join('$'), values });
      return 'fragment';
    }) as unknown as postgres.Sql;
    expect(sessionSiteIdSql(tag, 'sta_2')).toBe('fragment');
    expect(calls).toEqual([
      { text: '(SELECT site_id FROM charging_stations WHERE id = $)', values: ['sta_2'] },
    ]);
  });
});
