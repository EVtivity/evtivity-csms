// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { readFileSync, readdirSync } from 'node:fs';
import { describe, it, expect } from 'vitest';
import {
  applyMigrationFile,
  isNoTransaction,
  migrationFileProblems,
  splitStatements,
  type MigrationSql,
} from '../../../../scripts/lib/migration-files.mjs';

const MIGRATIONS_DIR = new URL('../migrations/', import.meta.url);
const INDEX_FILE = readFileSync(new URL('0476_release_0_1_46_indexes.sql', MIGRATIONS_DIR), 'utf8');
const INDEX_FILE_0147 = readFileSync(
  new URL('0478_release_0_1_47_indexes.sql', MIGRATIONS_DIR),
  'utf8',
);

type Call = { kind: 'unsafe' | 'insert' | 'begin' | 'commit'; inTx: boolean; text: string };

/** A postgres.js stand-in that records each query and whether a transaction was open. */
function fakeSql(failOn?: RegExp): { sql: MigrationSql; calls: Call[] } {
  const calls: Call[] = [];
  let inTx = false;
  const make = (): MigrationSql =>
    Object.assign(
      (strings: TemplateStringsArray, ...values: unknown[]) => {
        calls.push({ kind: 'insert', inTx, text: strings.join('?') + JSON.stringify(values) });
        return Promise.resolve([]);
      },
      {
        unsafe: (query: string) => {
          calls.push({ kind: 'unsafe', inTx, text: query });
          if (failOn?.test(query) === true) return Promise.reject(new Error('statement failed'));
          return Promise.resolve([]);
        },
        begin: async (fn: (tx: MigrationSql) => Promise<unknown>) => {
          calls.push({ kind: 'begin', inTx, text: '' });
          inTx = true;
          try {
            const result = await fn(make());
            calls.push({ kind: 'commit', inTx, text: '' });
            return result;
          } finally {
            inTx = false;
          }
        },
      },
    );
  return { sql: make(), calls };
}

const NO_TX = [
  '-- evtivity:no-transaction',
  'DO $$ BEGIN PERFORM 1; END $$;',
  '--> statement-breakpoint',
  'CREATE UNIQUE INDEX CONCURRENTLY IF NOT EXISTS a_idx ON t (a);',
  '--> statement-breakpoint',
  'DROP INDEX CONCURRENTLY IF EXISTS b_idx;',
  '',
].join('\n');

describe('isNoTransaction', () => {
  it('reads the marker on the first line only', () => {
    expect(isNoTransaction(NO_TX)).toBe(true);
    expect(isNoTransaction('-- evtivity:no-transaction\r\nSELECT 1;')).toBe(true);
    expect(isNoTransaction('  -- evtivity:no-transaction  \nSELECT 1;')).toBe(true);
    expect(isNoTransaction('-- header\n-- evtivity:no-transaction\nSELECT 1;')).toBe(false);
    expect(isNoTransaction('-- evtivity:no-transactions\nSELECT 1;')).toBe(false);
    expect(isNoTransaction('SELECT 1;')).toBe(false);
  });
});

describe('splitStatements', () => {
  it('splits on the breakpoint marker and drops empty chunks', () => {
    expect(
      splitStatements('SELECT 1;\n--> statement-breakpoint\n\n--> statement-breakpoint\nSELECT 2;'),
    ).toEqual(['SELECT 1;\n', '\nSELECT 2;']);
  });
});

describe('applyMigrationFile', () => {
  const file = (contents: string) => ({ contents, hash: 'h1', when: 1791000047700 });

  it('runs a no-transaction file statement by statement outside a transaction, then records it', async () => {
    const { sql, calls } = fakeSql();
    await applyMigrationFile(sql, file(NO_TX));
    expect(calls.map((c) => c.kind)).toEqual(['unsafe', 'unsafe', 'unsafe', 'insert']);
    expect(calls.every((c) => !c.inTx)).toBe(true);
    expect(calls[1]!.text).toContain('CREATE UNIQUE INDEX CONCURRENTLY');
    expect(calls[3]!.text).toContain('__drizzle_migrations');
    expect(calls[3]!.text).toContain('"h1",1791000047700');
  });

  it('records no hash when a no-transaction statement fails, so the next run repeats the file', async () => {
    const { sql, calls } = fakeSql(/CONCURRENTLY IF NOT EXISTS/);
    await expect(applyMigrationFile(sql, file(NO_TX))).rejects.toThrow('statement failed');
    expect(calls.map((c) => c.kind)).toEqual(['unsafe', 'unsafe']);

    // Rerun after the crash: every statement runs again, from the first.
    const rerun = fakeSql();
    await applyMigrationFile(rerun.sql, file(NO_TX));
    expect(rerun.calls.map((c) => c.kind)).toEqual(['unsafe', 'unsafe', 'unsafe', 'insert']);
  });

  it('runs a transactional file and its record in one transaction', async () => {
    const { sql, calls } = fakeSql();
    await applyMigrationFile(sql, file('SELECT 1;\n--> statement-breakpoint\nSELECT 2;'));
    expect(calls.map((c) => [c.kind, c.inTx])).toEqual([
      ['begin', false],
      ['unsafe', true],
      ['unsafe', true],
      ['insert', true],
      ['commit', true],
    ]);
  });
});

describe('migrationFileProblems', () => {
  it('accepts a well-formed no-transaction file', () => {
    expect(migrationFileProblems(NO_TX)).toEqual([]);
  });

  it('refuses CONCURRENTLY in a transactional file, ignoring comments', () => {
    expect(
      migrationFileProblems('-- CREATE INDEX CONCURRENTLY is not allowed here\nSELECT 1;'),
    ).toEqual([]);
    expect(migrationFileProblems('CREATE INDEX CONCURRENTLY IF NOT EXISTS a ON t (a);')).toEqual([
      expect.stringContaining('needs a no-transaction file'),
    ]);
  });

  it('refuses a marker below the first line', () => {
    expect(migrationFileProblems('SELECT 1;\n-- evtivity:no-transaction\n')).toEqual([
      expect.stringContaining('only on the first line'),
    ]);
  });

  it('refuses statements a rerun after a crash would fail', () => {
    const problems = migrationFileProblems(
      [
        '-- evtivity:no-transaction',
        'CREATE INDEX CONCURRENTLY a ON t (a);',
        '--> statement-breakpoint',
        'DROP INDEX CONCURRENTLY b;',
        '--> statement-breakpoint',
        'SELECT 1; CREATE INDEX CONCURRENTLY IF NOT EXISTS c ON t (c);',
      ].join('\n'),
    );
    expect(problems).toEqual([
      expect.stringContaining('needs IF NOT EXISTS'),
      expect.stringContaining('needs IF EXISTS'),
      expect.stringContaining('alone between breakpoints'),
    ]);
  });

  it('finds no problem in any shipped migration', () => {
    for (const name of readdirSync(MIGRATIONS_DIR).filter((f) => f.endsWith('.sql'))) {
      const contents = readFileSync(new URL(name, MIGRATIONS_DIR), 'utf8');
      expect({ name, problems: migrationFileProblems(contents) }).toEqual({ name, problems: [] });
    }
  });
});

describe('0476_release_0_1_46_indexes.sql', () => {
  const statements = splitStatements(INDEX_FILE);
  const creates = statements
    .map((s, i) => ({ i, name: /INDEX CONCURRENTLY IF NOT EXISTS (\w+)/.exec(s)?.[1] }))
    .filter((c): c is { i: number; name: string } => c.name !== undefined);

  it('runs outside a transaction', () => {
    expect(isNoTransaction(INDEX_FILE)).toBe(true);
    expect(creates.map((c) => c.name)).toEqual([
      'meter_values_station_dedup_idx',
      'uq_transaction_events_event',
      'idx_sessions_site_started_at',
      'uq_ocpi_cdrs_received',
      'uq_ocpi_roaming_sessions_received',
      'idx_sessions_driver_created',
      'uq_guest_sessions_charging_session',
      'idx_meter_values_evse_id',
    ]);
  });

  it('drops the indexes a unique index covers, after the unique one exists', () => {
    // payment_records_session_id_unique already covers session_id.
    expect(INDEX_FILE).toMatch(/DROP INDEX CONCURRENTLY IF EXISTS idx_payment_records_session_id;/);
    const unique = INDEX_FILE.indexOf(
      'CREATE UNIQUE INDEX CONCURRENTLY IF NOT EXISTS uq_guest_sessions',
    );
    const drop = INDEX_FILE.indexOf(
      'DROP INDEX CONCURRENTLY IF EXISTS idx_guest_sessions_charging_session;',
    );
    expect(unique).toBeGreaterThan(-1);
    expect(drop).toBeGreaterThan(unique);
  });

  it('drops an INVALID index of the same name before each concurrent build', () => {
    for (const { i, name } of creates) {
      const before = statements.slice(0, i).join('\n');
      expect(before).toMatch(
        new RegExp(`to_regclass\\('${name}'\\) AND NOT indisvalid[\\s\\S]*DROP INDEX ${name};`),
      );
    }
  });

  it('keeps the old meter values index for pods of the previous release', () => {
    expect(INDEX_FILE).not.toMatch(/DROP INDEX[^;]*meter_values_dedup_idx/);
  });
});

describe('0478_release_0_1_47_indexes.sql', () => {
  it('runs outside a transaction and only drops the old meter values index', () => {
    expect(isNoTransaction(INDEX_FILE_0147)).toBe(true);
    expect(splitStatements(INDEX_FILE_0147).map((s) => s.trim())).toEqual([
      expect.stringMatching(/DROP INDEX CONCURRENTLY IF EXISTS meter_values_dedup_idx;$/),
    ]);
    expect(migrationFileProblems(INDEX_FILE_0147)).toEqual([]);
  });
});
