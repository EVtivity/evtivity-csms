// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { describe, it, expect } from 'vitest';
import { PgDialect, pgTable, varchar } from 'drizzle-orm/pg-core';
import { emailEquals } from '../lib/email-match.js';

const people = pgTable('people', { email: varchar('email', { length: 255 }) });

describe('emailEquals', () => {
  it('compares lower(column) with the lowercased email as an exact match', () => {
    const query = new PgDialect().sqlToQuery(emailEquals(people.email, 'A_b%@Example.COM'));
    expect(query.sql).toBe('lower("people"."email") = $1');
    expect(query.params).toEqual(['a_b%@example.com']);
  });
});
