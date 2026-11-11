// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { readdirSync } from 'node:fs';
import { describe, it, expect } from 'vitest';
import { sql, type SQL } from 'drizzle-orm';
import { PgDialect } from 'drizzle-orm/pg-core';
import type { ListSortDefinition } from '../lib/list-sort.js';

// Every list sort definition (`api/routes.md`, "List sorting"), rendered with the real schema.
const sortsDir = new URL('../lib/sorts/', import.meta.url);
const modules: Record<string, Record<string, unknown>> = {};
for (const file of readdirSync(sortsDir)
  .filter((f) => f.endsWith('.ts'))
  .sort()) {
  modules[`../lib/sorts/${file}`] = (await import(new URL(file, sortsDir).href)) as Record<
    string,
    unknown
  >;
}

function isDefinition(value: unknown): value is ListSortDefinition<string> {
  return (
    typeof value === 'object' &&
    value != null &&
    'keys' in value &&
    'orderBy' in value &&
    'query' in value
  );
}

const definitions: Array<[string, ListSortDefinition<string>]> = [];
for (const [path, exports] of Object.entries(modules)) {
  for (const [name, value] of Object.entries(exports)) {
    if (isDefinition(value))
      definitions.push([`${path.replace('../lib/sorts/', '')} ${name}`, value]);
  }
}

const dialect = new PgDialect();
function render(order: SQL[]): string {
  return dialect.sqlToQuery(sql.join(order, sql`, `)).sql;
}

describe('list sort definitions', () => {
  it('finds the definitions', () => {
    expect(definitions.length).toBeGreaterThan(0);
  });

  it.each(definitions)('%s sorts every key with NULLS LAST and a tie-breaker', (_name, def) => {
    const defaultSql = render(def.orderBy({}));
    expect(defaultSql.length).toBeGreaterThan(0);
    const tieBreakers = new Set<string>();
    for (const key of def.keys) {
      for (const order of ['asc', 'desc'] as const) {
        const terms = def.orderBy({ sort: key, order });
        expect(terms, `${key} ${order}`).toHaveLength(2);
        const [first, second] = terms.map((term) => render([term]));
        expect(first, `${key} ${order}`).toMatch(new RegExp(` ${order}( nulls last)?$`));
        expect(second, `${key} ${order}`).toMatch(new RegExp(` ${order}$`));
        tieBreakers.add(second?.replace(/ (asc|desc)$/, '') ?? '');
      }
    }
    // One tie-breaker (the primary key) for every key of a list.
    expect(tieBreakers.size).toBe(1);
    // A key the list does not offer falls back to the default order.
    expect(render(def.orderBy({ sort: '__proto__', order: 'desc' }))).toBe(defaultSql);
  });
});
