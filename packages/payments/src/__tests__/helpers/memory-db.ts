// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

// A small in-memory stand-in for the drizzle `db` client and operators, for
// unit tests of services whose correctness lives in their WHERE guards
// (compare-and-set transitions). Tables are proxies whose properties are
// column references; `drizzleOperators` builds condition objects that
// `evaluate` checks against rows, so a guarded UPDATE changes a row only when
// its from-states match, as Postgres would.

type Row = Record<string, unknown>;

interface ColumnRef {
  __col: true;
  table: string;
  col: string;
}

export interface MemoryTable {
  readonly __table: string;
}

const TABLE = Symbol('table');

export function memoryTable(name: string): MemoryTable & Record<string, ColumnRef> {
  return new Proxy(
    { [TABLE]: name },
    {
      get(target, key) {
        if (key === TABLE || key === '__table') return name;
        if (typeof key === 'symbol') return (target as Record<symbol, unknown>)[key];
        return { __col: true, table: name, col: key } satisfies ColumnRef;
      },
    },
  ) as unknown as MemoryTable & Record<string, ColumnRef>;
}

function tableName(t: unknown): string {
  return (t as MemoryTable).__table;
}

function isTable(v: unknown): v is MemoryTable {
  return typeof v === 'object' && v != null && typeof (v as MemoryTable).__table === 'string';
}

function isCol(v: unknown): v is ColumnRef {
  return typeof v === 'object' && v != null && Reflect.get(v, '__col') === true;
}

type Cond =
  | { op: 'and' | 'or'; args: Array<Cond | undefined> }
  | { op: 'eq' | 'lt'; a: unknown; b: unknown }
  | { op: 'inArray'; a: unknown; values: unknown[] }
  | { op: 'isNull' | 'isNotNull'; a: unknown }
  | { op: 'sql'; text: string };

/** One joined row: table name to row (null for an unmatched left join). */
type Combo = Record<string, Row | null>;

function value(v: unknown, combo: Combo): unknown {
  if (isCol(v)) return combo[v.table]?.[v.col] ?? null;
  return v;
}

function cmp(v: unknown): unknown {
  return v instanceof Date ? v.getTime() : v;
}

export function evaluate(cond: Cond | undefined, combo: Combo): boolean {
  if (cond == null) return true;
  switch (cond.op) {
    case 'and':
      return cond.args.every((c) => evaluate(c, combo));
    case 'or':
      return cond.args.some((c) => evaluate(c, combo));
    case 'eq':
      return cmp(value(cond.a, combo)) === cmp(value(cond.b, combo));
    case 'lt': {
      const a = value(cond.a, combo);
      const b = value(cond.b, combo);
      if (a == null || b == null) return false;
      return (cmp(a) as number) < (cmp(b) as number);
    }
    case 'inArray':
      return cond.values.includes(value(cond.a, combo));
    case 'isNull':
      return value(cond.a, combo) == null;
    case 'isNotNull':
      return value(cond.a, combo) != null;
    case 'sql':
      return cond.text.trim() !== 'false';
  }
}

export const drizzleOperators = {
  and: (...args: Array<Cond | undefined>): Cond => ({ op: 'and', args }),
  or: (...args: Array<Cond | undefined>): Cond => ({ op: 'or', args }),
  eq: (a: unknown, b: unknown): Cond => ({ op: 'eq', a, b }),
  lt: (a: unknown, b: unknown): Cond => ({ op: 'lt', a, b }),
  inArray: (a: unknown, values: unknown[]): Cond => ({ op: 'inArray', a, values }),
  isNull: (a: unknown): Cond => ({ op: 'isNull', a }),
  isNotNull: (a: unknown): Cond => ({ op: 'isNotNull', a }),
  sql: (strings: TemplateStringsArray): Cond => ({ op: 'sql', text: strings.join('') }),
};

export interface MemoryDb {
  tables: Record<string, Row[]>;
  /** Unique keys per table, checked by `onConflictDoNothing`. */
  uniques: Record<string, string[][]>;
  /** Defaults merged into each inserted row (before the values). */
  defaults: Record<string, () => Row>;
  /** Every UPDATE run: table, values, and how many rows it changed. */
  updates: Array<{ table: string; values: Row; changed: number }>;
  /** Next errors thrown by `db.update(...)` for a table, in order. */
  failNextUpdate: Record<string, Error[]>;
  reset(): void;
  client: Record<string, unknown>;
}

function thenable<T>(run: () => T): PromiseLike<T> & Record<string, unknown> {
  return {
    then: (resolve: (v: T) => unknown, reject: (e: unknown) => unknown) =>
      Promise.resolve().then(run).then(resolve, reject),
  } as PromiseLike<T> & Record<string, unknown>;
}

function project(fields: Record<string, unknown> | undefined, base: string, combo: Combo): Row {
  if (fields == null) return { ...(combo[base] ?? {}) };
  const out: Row = {};
  for (const [k, v] of Object.entries(fields)) {
    if (isTable(v)) out[k] = combo[tableName(v)] == null ? null : { ...combo[tableName(v)] };
    else out[k] = value(v, combo);
  }
  return out;
}

export function createMemoryDb(): MemoryDb {
  const state: MemoryDb = {
    tables: {},
    uniques: {},
    defaults: {},
    updates: [],
    failNextUpdate: {},
    reset() {
      state.tables = {};
      state.updates = [];
      state.failNextUpdate = {};
    },
    client: {},
  };
  const rowsOf = (name: string): Row[] => (state.tables[name] ??= []);

  function select(fields?: Record<string, unknown>) {
    let base = '';
    const joins: Array<{ table: string; on: Cond; left: boolean }> = [];
    let where: Cond | undefined;
    let limit = Infinity;
    const run = (): Row[] => {
      let combos: Combo[] = rowsOf(base).map((r) => ({ [base]: r }));
      for (const j of joins) {
        const next: Combo[] = [];
        for (const c of combos) {
          const matches = rowsOf(j.table).filter((r) => evaluate(j.on, { ...c, [j.table]: r }));
          if (matches.length === 0 && j.left) next.push({ ...c, [j.table]: null });
          for (const r of matches) next.push({ ...c, [j.table]: r });
        }
        combos = next;
      }
      return combos
        .filter((c) => evaluate(where, c))
        .slice(0, limit)
        .map((c) => project(fields, base, c));
    };
    const chain = thenable(run);
    Object.assign(chain, {
      from(t: unknown) {
        base = tableName(t);
        return chain;
      },
      innerJoin(t: unknown, on: Cond) {
        joins.push({ table: tableName(t), on, left: false });
        return chain;
      },
      leftJoin(t: unknown, on: Cond) {
        joins.push({ table: tableName(t), on, left: true });
        return chain;
      },
      where(c: Cond) {
        where = c;
        return chain;
      },
      limit(n: number) {
        limit = n;
        return chain;
      },
      for() {
        return chain;
      },
      orderBy() {
        return chain;
      },
    });
    return chain;
  }

  function update(t: unknown) {
    const name = tableName(t);
    let values: Row = {};
    let where: Cond | undefined;
    const run = (): Row[] => {
      const fail = state.failNextUpdate[name]?.shift();
      if (fail != null) throw fail;
      const changed: Row[] = [];
      for (const r of rowsOf(name)) {
        if (!evaluate(where, { [name]: r })) continue;
        for (const [k, v] of Object.entries(values)) if (v !== undefined) r[k] = v;
        changed.push(r);
      }
      state.updates.push({ table: name, values, changed: changed.length });
      return changed;
    };
    const chain = {
      set(v: Row) {
        values = v;
        return chain;
      },
      where(c: Cond) {
        where = c;
        const w = thenable(() => {
          run();
        });
        Object.assign(w, {
          returning: (fields?: Record<string, unknown>) =>
            thenable(() => run().map((r) => project(fields, name, { [name]: r }))),
        });
        return w;
      },
    };
    return chain;
  }

  function insert(t: unknown) {
    const name = tableName(t);
    return {
      values(v: Row | Row[]) {
        const list = Array.isArray(v) ? v : [v];
        let ignoreConflicts = false;
        const run = (): Row[] => {
          const added: Row[] = [];
          for (const item of list) {
            const row: Row = { ...(state.defaults[name]?.() ?? {}), ...item };
            const clash = (state.uniques[name] ?? []).some((key) =>
              rowsOf(name).some((r) => key.every((k) => r[k] === row[k])),
            );
            if (clash) {
              if (ignoreConflicts) continue;
              throw new Error(`unique violation on ${name}`);
            }
            rowsOf(name).push(row);
            added.push(row);
          }
          return added;
        };
        const chain = thenable(() => {
          run();
        });
        Object.assign(chain, {
          onConflictDoNothing() {
            ignoreConflicts = true;
            return chain;
          },
          returning: (fields?: Record<string, unknown>) =>
            thenable(() => run().map((r) => project(fields, name, { [name]: r }))),
        });
        return chain;
      },
    };
  }

  function del(t: unknown) {
    const name = tableName(t);
    return {
      where(c: Cond) {
        return thenable(() => {
          state.tables[name] = rowsOf(name).filter((r) => !evaluate(c, { [name]: r }));
        });
      },
    };
  }

  const client: Record<string, unknown> = {
    select,
    update,
    insert,
    delete: del,
  };
  client['transaction'] = async (fn: (tx: unknown) => Promise<unknown>) => fn(client);
  state.client = client;
  return state;
}
