// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { sql, type AnyColumn, type SQL } from 'drizzle-orm';
import { z } from 'zod';

/** The direction of a list sort. */
export type ListSortOrder = 'asc' | 'desc';

/** What a list route reads from its query: an allowlisted sort key and a direction. */
export interface ListSortParams {
  sort?: string | undefined;
  order?: ListSortOrder | undefined;
}

/** A sortable column of a list: a Drizzle column or an SQL expression over the list's FROM. */
export type ListSortExpression = AnyColumn | SQL;

/**
 * One list's sortable columns. The keys are what clients send (`sort=name`), never a raw
 * column name: the route schema accepts only these keys (400 `VALIDATION_ERROR` otherwise),
 * and each maps to its own SQL expression.
 */
export interface ListSortDefinition<K extends string> {
  /** The sort keys, for the route schema enum and the OpenAPI spec. */
  readonly keys: readonly [K, ...K[]];
  /** Query schema fields to spread into the list route's querystring schema. */
  readonly query: {
    sort: z.ZodOptional<z.ZodEnum<{ [P in K]: P }>>;
    order: z.ZodOptional<z.ZodEnum<{ asc: 'asc'; desc: 'desc' }>>;
  };
  /**
   * The ORDER BY of one request: the chosen column in the chosen direction with NULLS LAST,
   * then the tie-breaker (the primary key) in the same direction, so paging is stable.
   * Without a sort key, the list's default order, unchanged.
   */
  orderBy(params: ListSortParams): SQL[];
}

function isNotNullColumn(expression: ListSortExpression): boolean {
  // Read as data, not with drizzle's is(): route tests mock drizzle-orm and the tables.
  const value: unknown = expression;
  return (
    typeof value === 'object' && value !== null && 'notNull' in value && value.notNull === true
  );
}

/**
 * A person's name as one sort expression, the way lists show it ("First Last"); null when
 * both parts are empty, so rows without a person sort last.
 */
export function sortablePersonName(firstName: AnyColumn | SQL, lastName: AnyColumn | SQL): SQL {
  return sql`nullif(trim(concat_ws(' ', ${firstName}, ${lastName})), '')`;
}

interface ListSortOptions {
  /** The primary key of the listed rows: the last ORDER BY term of every sorted request. */
  tieBreaker: ListSortExpression;
  /** The order of a request without a sort key (the list's order before sorting existed). */
  defaultOrder: SQL[];
}

/**
 * Defines the server-side sort of one list (`api/routes.md`, "List sorting"). Spread
 * `query` into the route's querystring schema and call `orderBy(request.query)` in the
 * SELECT. A sort key the definition does not hold never reaches SQL: the schema refuses it,
 * and `orderBy` falls back to the default order.
 */
export function defineListSort<const K extends string>(
  columns: { readonly [P in K]: ListSortExpression },
  options: ListSortOptions,
): ListSortDefinition<K> {
  const keys = Object.keys(columns) as K[];
  if (keys.length === 0) {
    throw new Error('defineListSort needs at least one sortable column');
  }
  const keyTuple = keys as [K, ...K[]];
  const sortSchema = z
    .enum(keyTuple)
    .optional()
    .describe(`Column to sort by: ${keys.join(', ')}. Without it, the default order applies.`);
  const orderSchema = z
    .enum(['asc', 'desc'])
    .optional()
    .describe('Sort direction (default asc). Used only with sort.');
  return {
    keys: keyTuple,
    query: {
      sort: sortSchema,
      order: orderSchema,
    },
    orderBy(params: ListSortParams): SQL[] {
      const key = params.sort;
      if (key == null || !Object.prototype.hasOwnProperty.call(columns, key)) {
        return options.defaultOrder;
      }
      const expression = columns[key as K];
      const direction = params.order === 'desc' ? sql.raw('desc') : sql.raw('asc');
      // A NOT NULL column has no nulls to place: leaving NULLS LAST out lets a plain index
      // serve the descending sort too (a backward scan reads DESC NULLS FIRST).
      if (isNotNullColumn(expression)) {
        return [sql`${expression} ${direction}`, sql`${options.tieBreaker} ${direction}`];
      }
      return [sql`${expression} ${direction} nulls last`, sql`${options.tieBreaker} ${direction}`];
    },
  };
}
