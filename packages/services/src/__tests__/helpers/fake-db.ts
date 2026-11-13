// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

// A recording stand-in for the `@evtivity/database` module in unit tests.
//
// Every Drizzle builder (`db.select().from(t).where(...)`, `db.update(t).set(...)`,
// `db.insert(t).values(...)`, `db.delete(t)`, `db.execute(sql)`) and every
// postgres.js tagged query (`client\`...\``) is recorded as one `DbCall` when it
// is awaited, and answers the rows a test queued for it (`fake.queue`), or `[]`.
// Tables are proxies whose columns read as "<table>.<column>", so the real
// drizzle-orm operators (`eq`, `and`, `sql`) build conditions on them.
//
// Use inside a hoisted mock:
//
//   const fake = vi.hoisted(() => ({ db: undefined as unknown as FakeDb }));
//   vi.mock('@evtivity/database', async () => {
//     const { createFakeDb, fakeDatabaseModule } = await import('./helpers/fake-db.js');
//     fake.db = createFakeDb();
//     return fakeDatabaseModule(fake.db, { writeAudit: ... });
//   });

export type DbCallKind = 'select' | 'insert' | 'update' | 'delete' | 'execute' | 'client';

export interface DbCall {
  kind: DbCallKind;
  /** Table name for Drizzle builders (`from`, `insert`, `update`, `delete`). */
  table?: string | undefined;
  /** Recorded inside `db.transaction` (or `client.begin`). */
  inTx: boolean;
  /** Every builder method called, in order, with its arguments. */
  ops: { name: string; args: unknown[] }[];
  /** `values(...)` of an insert. */
  values?: unknown;
  /** `set(...)` of an update (or of `onConflictDoUpdate`). */
  set?: unknown;
  /** The SQL text of a `client` query (parameters as `$`), or of `db.execute`. */
  text?: string;
  /** The parameters of a `client` query. */
  params?: unknown[];
}

type Matcher = (call: DbCall) => boolean;

interface Queued {
  match: Matcher;
  rows: unknown;
  once: boolean;
}

export interface FakeDb {
  db: Record<string, unknown>;
  client: unknown;
  calls: DbCall[];
  /**
   * Answers the next call that matches with `rows` (once). `match` is a kind,
   * a "kind:table" key, a SQL text fragment of a client query (`client:INSERT INTO x`),
   * or a predicate.
   */
  queue: (match: string | Matcher, rows: unknown) => void;
  /** Like `queue` but answers every matching call. */
  always: (match: string | Matcher, rows: unknown) => void;
  /** Makes the next matching call reject with `error`. */
  fail: (match: string | Matcher, error: Error) => void;
  /** Calls of one kind (and table, or text fragment for client calls). */
  find: (kind: DbCallKind, tableOrText?: string) => DbCall[];
  reset: () => void;
}

/** A table stand-in: any column reads as "<name>.<column>". */
export function fakeTable(name: string): Record<string, unknown> {
  const target: Record<string | symbol, unknown> = { __table: name };
  return new Proxy(target, {
    get: (t, prop) => {
      if (prop in t) return t[prop];
      if (typeof prop === 'symbol') return undefined;
      return `${name}.${prop}`;
    },
  });
}

function toMatcher(match: string | Matcher): Matcher {
  if (typeof match === 'function') return match;
  const colon = match.indexOf(':');
  if (colon < 0) return (c) => c.kind === match;
  const kind = match.slice(0, colon);
  const rest = match.slice(colon + 1);
  return (c) => {
    if (c.kind !== kind) return false;
    if (c.kind === 'client' || c.kind === 'execute') return (c.text ?? '').includes(rest);
    return c.table === rest;
  };
}

const FRAGMENT = Symbol('fragment');

interface Fragment {
  [FRAGMENT]: true;
  text: string;
  params: unknown[];
}

function isFragment(v: unknown): v is Fragment {
  return typeof v === 'object' && v !== null && FRAGMENT in v;
}

export function createFakeDb(): FakeDb {
  const calls: DbCall[] = [];
  const queued: Queued[] = [];
  const failures: { match: Matcher; error: Error }[] = [];

  const answer = (call: DbCall): Promise<unknown> => {
    calls.push(call);
    const f = failures.findIndex((q) => q.match(call));
    if (f >= 0) {
      const [hit] = failures.splice(f, 1);
      return Promise.reject(hit!.error);
    }
    const i = queued.findIndex((q) => q.match(call));
    if (i < 0) return Promise.resolve([]);
    const hit = queued[i]!;
    if (hit.once) queued.splice(i, 1);
    return Promise.resolve(hit.rows);
  };

  const chain = (call: DbCall): unknown => {
    const proxy: unknown = new Proxy(function () {}, {
      get: (_t, prop) => {
        if (prop === 'then') {
          return (resolve: (v: unknown) => unknown, reject: (e: unknown) => unknown) =>
            answer(call).then(resolve, reject);
        }
        if (prop === 'catch' || prop === 'finally') {
          const p = answer(call);
          return (p[prop as 'catch'] as (...a: unknown[]) => unknown).bind(p);
        }
        // Not a SQL wrapper: drizzle probes these on values it binds.
        if (typeof prop === 'symbol' || prop === 'getSQL' || prop === 'shouldOmitSQLParens') {
          return undefined;
        }
        return (...args: unknown[]) => {
          call.ops.push({ name: prop, args });
          if (prop === 'from') {
            const t = args[0] as { __table?: string } | undefined;
            call.table = t?.__table ?? call.table;
          } else if (prop === 'values') call.values = args[0];
          else if (prop === 'set') call.set = args[0];
          else if (prop === 'onConflictDoUpdate') {
            const cfg = args[0] as { set?: unknown } | undefined;
            if (cfg?.set != null && call.set == null) call.set = cfg.set;
          }
          return proxy;
        };
      },
    });
    return proxy;
  };

  const sqlText = (v: unknown): string => {
    const q = v as { queryChunks?: unknown[] } | undefined;
    if (q?.queryChunks == null) return String(v);
    return q.queryChunks
      .map((c) => {
        if (c == null) return '$';
        const chunk = c as { value?: unknown };
        if (Array.isArray(chunk.value)) return chunk.value.join('');
        if (typeof c === 'string') return c;
        return '$';
      })
      .join('');
  };

  const makeDb = (inTx: boolean): Record<string, unknown> => {
    const tableOf = (t: unknown): string | undefined => (t as { __table?: string }).__table;
    const dbObj: Record<string, unknown> = {
      select: (...args: unknown[]) =>
        chain({ kind: 'select', inTx, ops: [{ name: 'select', args }] }),
      selectDistinct: (...args: unknown[]) =>
        chain({ kind: 'select', inTx, ops: [{ name: 'selectDistinct', args }] }),
      selectDistinctOn: (...args: unknown[]) =>
        chain({ kind: 'select', inTx, ops: [{ name: 'selectDistinctOn', args }] }),
      insert: (t: unknown) =>
        chain({ kind: 'insert', table: tableOf(t), inTx, ops: [{ name: 'insert', args: [] }] }),
      update: (t: unknown) =>
        chain({ kind: 'update', table: tableOf(t), inTx, ops: [{ name: 'update', args: [] }] }),
      delete: (t: unknown) =>
        chain({ kind: 'delete', table: tableOf(t), inTx, ops: [{ name: 'delete', args: [] }] }),
      execute: (q: unknown) =>
        chain({ kind: 'execute', inTx, text: sqlText(q), ops: [{ name: 'execute', args: [q] }] }),
      transaction: async (fn: (tx: Record<string, unknown>) => Promise<unknown>) => fn(txDb),
    };
    return dbObj;
  };

  const makeClient = (inTx: boolean): unknown => {
    const fn = (first: unknown, ...rest: unknown[]): unknown => {
      if (Array.isArray(first) && 'raw' in first) {
        const strings = first as unknown as readonly string[];
        let text = strings[0] ?? '';
        const params: unknown[] = [];
        rest.forEach((v, i) => {
          if (isFragment(v)) {
            text += v.text;
            params.push(...v.params);
          } else {
            text += '$';
            params.push(v);
          }
          text += strings[i + 1] ?? '';
        });
        const frag: Fragment = { [FRAGMENT]: true, text, params };
        const call: DbCall = { kind: 'client', inTx, ops: [], text, params };
        return new Proxy(frag, {
          get: (t, prop) => {
            if (prop === 'then') {
              return (resolve: (v: unknown) => unknown, reject: (e: unknown) => unknown) =>
                answer(call).then(resolve, reject);
            }
            return (t as unknown as Record<string | symbol, unknown>)[prop];
          },
        });
      }
      // `client(values)` helper (IN lists, identifiers): inlined as one parameter.
      const helper: Fragment = { [FRAGMENT]: true, text: '$', params: [first] };
      return helper;
    };
    const c = fn as unknown as Record<string, unknown>;
    c['begin'] = async (cb: (sql: unknown) => Promise<unknown>) => cb(txClient);
    c['unsafe'] = (text: string, params: unknown[] = []) =>
      chain({ kind: 'client', inTx, text, params, ops: [] });
    c['json'] = (v: unknown) => v;
    c['array'] = (v: unknown) => v;
    return c;
  };

  const txDb = makeDb(true);
  const txClient = makeClient(true);

  return {
    db: makeDb(false),
    client: makeClient(false),
    calls,
    queue: (match, rows) => queued.push({ match: toMatcher(match), rows, once: true }),
    always: (match, rows) => queued.push({ match: toMatcher(match), rows, once: false }),
    fail: (match, error) => failures.push({ match: toMatcher(match), error }),
    find: (kind, tableOrText) =>
      calls.filter(
        (c) =>
          c.kind === kind &&
          (tableOrText == null ||
            (kind === 'client' || kind === 'execute'
              ? (c.text ?? '').includes(tableOrText)
              : c.table === tableOrText)),
      ),
    reset: () => {
      calls.length = 0;
      queued.length = 0;
      failures.length = 0;
    },
  };
}

/** The arguments of the first call of builder method `name`, or undefined. */
export function opArgs(call: DbCall | undefined, name: string): unknown[] | undefined {
  return call?.ops.find((o) => o.name === name)?.args;
}

/**
 * The parameters a Drizzle condition (or any SQL chunk) binds, in order. With
 * fake tables a column is bound as its "<table>.<column>" string, so
 * `eq(t.status, 'open')` renders the params `['t.status', 'open']`.
 */
export async function sqlParams(condition: unknown): Promise<unknown[]> {
  if (condition == null) return [];
  const { PgDialect } = await import('drizzle-orm/pg-core');
  const query = new PgDialect().sqlToQuery(condition as never);
  return query.params;
}

/** The SQL text a Drizzle condition renders to (columns as `$n` parameters). */
export async function sqlString(condition: unknown): Promise<string> {
  if (condition == null) return '';
  const { PgDialect } = await import('drizzle-orm/pg-core');
  return new PgDialect().sqlToQuery(condition as never).sql;
}

/**
 * The mocked module: `db`, `client`, the given extra exports, and a table
 * proxy for any other name (camelCase export names become snake_case tables).
 */
export function fakeDatabaseModule(
  fake: FakeDb,
  extra: Record<string, unknown> = {},
): Record<string, unknown> {
  const base: Record<string, unknown> = { db: fake.db, client: fake.client, ...extra };
  const tables = new Map<string, unknown>();
  return new Proxy(base, {
    has: () => true,
    get: (t, prop) => {
      if (prop in t) return t[prop as string];
      if (typeof prop === 'symbol' || prop === 'then' || prop === '__esModule') return undefined;
      if (!tables.has(prop)) {
        tables.set(prop, fakeTable(prop.replace(/[A-Z]/g, (m) => `_${m.toLowerCase()}`)));
      }
      return tables.get(prop);
    },
  });
}
