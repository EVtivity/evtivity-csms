// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { dirname, join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

// Every insert into charging_sessions stamps site_id with sessionSiteIdSql
// (lib/session-site.ts): the session keeps the site its station was at when it
// started, and no database trigger fills a missing value. Scanned: product
// source, seeds, E2E specs, and the integration tests with their factories.
// Migration replay tests (file name with "migration") are not scanned: they
// insert rows the way an older release did, against an older schema.

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', '..');
const PACKAGES_DIR = join(ROOT, 'packages');

const SKIP_DIRS = new Set(['__tests__', '__integration__', 'dist', 'generated', 'node_modules']);

const RAW_INSERT = /\bINSERT\s+INTO\s+"?charging_sessions"?(?![\w"])/gi;
const DRIZZLE_INSERT = /\.insert\(\s*chargingSessions\s*\)/g;
const HELPER_CALL = /\bsessionSiteIdSql\(/g;

function walk(dir: string, all: boolean): string[] {
  if (!existsSync(dir)) return [];
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      if (!SKIP_DIRS.has(entry.name) && entry.name !== 'e2e-results')
        out.push(...walk(join(dir, entry.name), all));
    } else if (/\.(?:ts|tsx|mts)$/.test(entry.name) && (all || !/\.test\.tsx?$/.test(entry.name))) {
      out.push(join(dir, entry.name));
    }
  }
  return out;
}

function scannedFiles(): string[] {
  const files: string[] = [];
  for (const pkg of readdirSync(PACKAGES_DIR, { withFileTypes: true })) {
    if (!pkg.isDirectory()) continue;
    const base = join(PACKAGES_DIR, pkg.name);
    files.push(...walk(join(base, 'src'), false));
    files.push(
      ...walk(join(base, 'src', '__integration__'), true).filter(
        (f) => !/migration[^/]*$/.test(f.split(sep).join('/')),
      ),
    );
    files.push(...walk(join(base, 'e2e'), true));
  }
  files.push(...walk(join(ROOT, 'e2e'), true));
  return files;
}

/**
 * Index of the backtick that closes the template literal `start` is inside,
 * skipping `${...}` expressions and template literals nested in them.
 */
function templateEnd(text: string, start: number): number {
  let i = start;
  while (i < text.length) {
    const ch = text[i];
    if (ch === '\\') {
      i += 2;
    } else if (ch === '`') {
      return i;
    } else if (ch === '$' && text[i + 1] === '{') {
      i = expressionEnd(text, i + 2);
    } else {
      i += 1;
    }
  }
  return text.length;
}

/** Index just past the `}` that closes a `${` expression starting at `start`. */
function expressionEnd(text: string, start: number): number {
  let depth = 1;
  let i = start;
  while (i < text.length && depth > 0) {
    const ch = text[i];
    if (ch === '`') {
      i = templateEnd(text, i + 1) + 1;
      continue;
    }
    if (ch === '{') depth += 1;
    if (ch === '}') depth -= 1;
    i += 1;
  }
  return i;
}

interface Finding {
  file: string;
  line: number;
}

/** Inserts in one file's text that do not stamp site_id through the helper. */
function unstampedInserts(text: string): number[] {
  const bad: number[] = [];
  const lineOf = (index: number): number => text.slice(0, index).split('\n').length;
  let helperCallsInRaw = 0;
  for (const m of text.matchAll(RAW_INSERT)) {
    const start = m.index;
    // The statement ends at the template literal's closing backtick, so
    // `${sessionSiteIdSql(sql, id)}` inside it is part of the window.
    const statement = text.slice(start, templateEnd(text, start));
    const calls = statement.match(HELPER_CALL)?.length ?? 0;
    if (calls === 0 || !/\bsite_id\b/.test(statement)) bad.push(lineOf(start));
    helperCallsInRaw += calls;
  }
  // A Drizzle insert can take rows built elsewhere in the file: the file needs
  // one helper call per insert beyond the calls its raw statements use.
  const drizzle = [...text.matchAll(DRIZZLE_INSERT)];
  const helperCalls = (text.match(HELPER_CALL)?.length ?? 0) - helperCallsInRaw;
  if (drizzle.length > helperCalls) {
    for (const m of drizzle.slice(helperCalls)) bad.push(lineOf(m.index));
  }
  return bad;
}

describe('charging_sessions inserts stamp site_id', () => {
  it('finds the known insert paths (the scan is not a no-op)', () => {
    const files = scannedFiles().map((f) => relative(ROOT, f).split(sep).join('/'));
    const withInsert = files.filter((f) => {
      const text = readFileSync(join(ROOT, f), 'utf8');
      return text.search(RAW_INSERT) !== -1 || text.search(DRIZZLE_INSERT) !== -1;
    });
    const expected = [
      'packages/ocpp/src/server/session-lifecycle/transaction-projector.ts',
      'packages/api/src/routes/portal/charger.ts',
      'packages/database/src/seed.ts',
      'packages/database/src/seed-rebill-sessions.ts',
    ];
    // The published repository has no integration tests; check them where they exist.
    if (existsSync(join(PACKAGES_DIR, 'api', 'src', '__integration__'))) {
      expected.push(
        'packages/api/src/__integration__/helpers/factories.ts',
        'packages/api/src/__integration__/31-reports.integration.test.ts',
        'packages/ocpp/src/__integration__/v21/63-transaction-lifecycle.integration.test.ts',
      );
    }
    expect(withInsert).toEqual(expect.arrayContaining(expected));
  });

  it('every scanned insert sets site_id through sessionSiteIdSql', () => {
    const findings: Finding[] = [];
    for (const file of scannedFiles()) {
      const text = readFileSync(file, 'utf8');
      for (const line of unstampedInserts(text)) {
        findings.push({ file: relative(ROOT, file).split(sep).join('/'), line });
      }
    }
    expect(findings).toEqual([]);
  });

  it('flags a raw insert without the helper', () => {
    const text =
      'await sql`\n  INSERT INTO charging_sessions (id, station_id) VALUES (${a}, ${b})\n`;';
    expect(unstampedInserts(text)).toEqual([2]);
  });

  it('flags a Drizzle insert in a file without the helper', () => {
    expect(unstampedInserts('await db.insert(chargingSessions).values(rows);')).toEqual([1]);
    expect(
      unstampedInserts(
        'const r = { siteId: sessionSiteIdSql(sql, s) };\nawait db.insert(chargingSessions).values(r);',
      ),
    ).toEqual([]);
  });
});
