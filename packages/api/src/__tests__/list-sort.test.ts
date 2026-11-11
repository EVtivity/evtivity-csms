// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { describe, it, expect } from 'vitest';
import { desc, sql, type SQL } from 'drizzle-orm';
import { PgDialect, pgTable, timestamp, varchar } from 'drizzle-orm/pg-core';
import { z } from 'zod';
import { defineListSort } from '../lib/list-sort.js';
import { zodSchema } from '../lib/zod-schema.js';

const things = pgTable('things', {
  id: varchar('id', { length: 30 }),
  name: varchar('name', { length: 255 }),
  createdAt: timestamp('created_at').notNull(),
});

const thingSort = defineListSort(
  { name: things.name, nameLower: sql`lower(${things.name})`, createdAt: things.createdAt },
  { tieBreaker: things.id, defaultOrder: [desc(things.createdAt), desc(things.id)] },
);

function render(order: SQL[]): string {
  return new PgDialect().sqlToQuery(sql.join(order, sql`, `)).sql;
}

describe('defineListSort', () => {
  it('keeps the default order without a sort key', () => {
    expect(render(thingSort.orderBy({}))).toBe('"things"."created_at" desc, "things"."id" desc');
    expect(render(thingSort.orderBy({ order: 'asc' }))).toBe(
      '"things"."created_at" desc, "things"."id" desc',
    );
  });

  it('sorts ascending by default, with NULLS LAST and the primary key as tie-breaker', () => {
    expect(render(thingSort.orderBy({ sort: 'name' }))).toBe(
      '"things"."name" asc nulls last, "things"."id" asc',
    );
  });

  it('sorts descending and takes SQL expressions', () => {
    expect(render(thingSort.orderBy({ sort: 'nameLower', order: 'desc' }))).toBe(
      'lower("things"."name") desc nulls last, "things"."id" desc',
    );
  });

  it('leaves NULLS LAST out for a NOT NULL column, so a plain index serves both directions', () => {
    expect(render(thingSort.orderBy({ sort: 'createdAt', order: 'desc' }))).toBe(
      '"things"."created_at" desc, "things"."id" desc',
    );
  });

  it('never puts a key it does not hold into SQL', () => {
    expect(render(thingSort.orderBy({ sort: 'name; drop table things' }))).toBe(
      '"things"."created_at" desc, "things"."id" desc',
    );
    expect(render(thingSort.orderBy({ sort: 'toString' }))).toBe(
      '"things"."created_at" desc, "things"."id" desc',
    );
  });

  it('gives the route schema an enum of the keys and of the directions', () => {
    const schema = z.object(thingSort.query);
    expect(schema.safeParse({ sort: 'createdAt', order: 'desc' }).success).toBe(true);
    expect(schema.safeParse({}).success).toBe(true);
    expect(schema.safeParse({ sort: 'id' }).success).toBe(false);
    expect(schema.safeParse({ sort: 'name', order: 'up' }).success).toBe(false);
    const json = zodSchema(schema) as { properties: Record<string, { enum?: string[] }> };
    expect(json.properties['sort']?.enum).toEqual(['name', 'nameLower', 'createdAt']);
    expect(json.properties['order']?.enum).toEqual(['asc', 'desc']);
  });
});
