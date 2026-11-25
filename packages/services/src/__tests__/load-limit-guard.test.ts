// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

// Guard: what a station might enforce has one rule, `mightEnforceKw` (and its
// EVSE and draw bound twins) in load-limit-entries.ts. This test parses the
// source of every package and fails when code elsewhere reads a limit record
// (`mightKw`, `sentKw`, a record's `limit.state` or `limit.commandId`, the
// transition functions), reads a stored entry's raw `allocatedKw` as a limit,
// or names a field of the earlier derived model, so no consumer can count a
// station another way.

import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';

const ROOT = resolve(fileURLToPath(new URL('.', import.meta.url)), '../../../..');

/** The state model, its service rule and its database writer. */
const RECORD_OWNERS = new Set([
  'packages/lib/src/load-limit-state.ts',
  'packages/services/src/load-limit-entries.ts',
  'packages/database/src/lib/load-management-state.ts',
]);

/** Reading or moving a limit record. */
const RECORD_NAMES = new Set([
  'mightKw',
  'sentKw',
  'limit.state',
  'limit.commandId',
  'limitMightKw',
  'limitTransition',
  'creditTransition',
]);

/**
 * A stored entry's allocation read from the raw row (`entry['allocatedKw']`):
 * the allocation of the last cycle says nothing about what the station holds.
 */
const RAW_ENTRY_NAMES = new Set(['allocatedKw']);

/** Fields of the derived model the state records replaced. */
const REMOVED_NAMES = new Set([
  'confirmedKw',
  'unconfirmedKw',
  'unconfirmed',
  'limitPending',
  'creditUntil',
  'awaitingReply',
  'sentCommandId',
  'sentLimit',
  'sentUnit',
  'enforcedLimitKw',
  'sendLostEntry',
]);

function sourceFiles(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    if (name === 'node_modules' || name === 'dist' || name.startsWith('__')) continue;
    if (name === 'generated' || name === 'e2e') continue;
    const path = join(dir, name);
    if (statSync(path).isDirectory()) sourceFiles(path, out);
    else if (/\.tsx?$/.test(name) && !name.endsWith('.d.ts')) out.push(path);
  }
  return out;
}

interface NameUse {
  name: string;
  line: number;
}

function namesUsed(path: string): { uses: NameUse[]; raw: NameUse[] } {
  const text = readFileSync(path, 'utf8');
  const file = ts.createSourceFile(path, text, ts.ScriptTarget.Latest, true);
  const found: NameUse[] = [];
  const raw: NameUse[] = [];
  const add = (name: string, node: ts.Node): void => {
    found.push({ name, line: file.getLineAndCharacterOfPosition(node.getStart()).line + 1 });
  };
  const visit = (node: ts.Node): void => {
    // A record field read through its holder: `<entry>.limit.state`, `.limit.commandId`.
    if (
      ts.isPropertyAccessExpression(node) &&
      (node.name.text === 'state' || node.name.text === 'commandId') &&
      ts.isPropertyAccessExpression(node.expression) &&
      node.expression.name.text === 'limit'
    ) {
      add(`limit.${node.name.text}`, node.name);
    }
    if (ts.isPropertyAccessExpression(node)) add(node.name.text, node.name);
    else if (ts.isElementAccessExpression(node) && ts.isStringLiteral(node.argumentExpression)) {
      add(node.argumentExpression.text, node.argumentExpression);
      raw.push({
        name: node.argumentExpression.text,
        line: file.getLineAndCharacterOfPosition(node.argumentExpression.getStart()).line + 1,
      });
    } else if (ts.isIdentifier(node) && ts.isCallExpression(node.parent)) {
      if (node.parent.expression === node) add(node.text, node);
    } else if (ts.isPropertyAssignment(node) || ts.isShorthandPropertyAssignment(node)) {
      if (ts.isIdentifier(node.name)) add(node.name.text, node.name);
    }
    ts.forEachChild(node, visit);
  };
  visit(file);
  return { uses: found, raw };
}

const files = readdirSync(join(ROOT, 'packages'))
  .map((pkg) => join(ROOT, 'packages', pkg, 'src'))
  .filter((dir) => {
    try {
      return statSync(dir).isDirectory();
    } catch {
      // fail-open: a package without a src folder holds no source to scan
      return false;
    }
  })
  .flatMap((dir) => sourceFiles(dir));

// Parsed once for both checks; a full-source scan gets the 30 s guard limit.
let parsed: Array<{ rel: string; uses: NameUse[]; raw: NameUse[] }> | null = null;
function parsedFiles(): Array<{ rel: string; uses: NameUse[]; raw: NameUse[] }> {
  parsed ??= files.map((path) => ({ rel: relative(ROOT, path), ...namesUsed(path) }));
  return parsed;
}

describe('load management limit records', () => {
  it('scans the source of the packages', () => {
    expect(files.some((f) => f.endsWith('load-limit-entries.ts'))).toBe(true);
    expect(files.length).toBeGreaterThan(500);
  });

  it(
    'are read and moved only by the state model, its rule and its writer',
    { timeout: 30_000 },
    () => {
      const offenders: string[] = [];
      for (const { rel, uses, raw } of parsedFiles()) {
        if (RECORD_OWNERS.has(rel)) continue;
        for (const use of uses) {
          if (RECORD_NAMES.has(use.name)) offenders.push(`${rel}:${String(use.line)} ${use.name}`);
        }
        for (const use of raw) {
          if (RAW_ENTRY_NAMES.has(use.name)) {
            offenders.push(`${rel}:${String(use.line)} ['${use.name}']`);
          }
        }
      }
      expect(offenders).toEqual([]);
    },
  );

  it('leave no field of the earlier derived model in the source', { timeout: 30_000 }, () => {
    const offenders: string[] = [];
    for (const { rel, uses } of parsedFiles()) {
      for (const use of uses) {
        if (REMOVED_NAMES.has(use.name)) offenders.push(`${rel}:${String(use.line)} ${use.name}`);
      }
    }
    expect(offenders).toEqual([]);
  });
});
