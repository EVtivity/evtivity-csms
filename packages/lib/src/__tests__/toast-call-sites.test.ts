// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

// Every CSMS and portal toast dismisses itself with the duration from
// toast-durations.ts. This scans the frontend source and fails on a toast call
// that sets its own duration or keeps the toast open.

import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, it, expect } from 'vitest';

const PACKAGES_DIR = path.resolve(import.meta.dirname, '../../..');
const FRONTEND_SRC = ['csms/src', 'portal/src'].map((p) => path.join(PACKAGES_DIR, p));

const FORBIDDEN_OPTION = /\b(duration|persistent|autoDismiss|dismissible)\s*:/;
const FORBIDDEN_VALUE = /\bInfinity\b/;

function sourceFiles(dir: string): string[] {
  const files: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name !== '__tests__' && entry.name !== 'node_modules') {
        files.push(...sourceFiles(full));
      }
    } else if (/\.tsx?$/.test(entry.name) && !/\.test\.tsx?$/.test(entry.name)) {
      files.push(full);
    }
  }
  return files;
}

// Returns the object literal of each `toast({ ... })` call.
function toastCalls(source: string): { line: number; options: string }[] {
  const calls: { line: number; options: string }[] = [];
  const callStart = /\btoast\(\s*\{/g;
  let match: RegExpExecArray | null;
  while ((match = callStart.exec(source)) != null) {
    const open = match.index + match[0].length - 1;
    let depth = 0;
    let end = source.length - 1;
    for (let i = open; i < source.length; i += 1) {
      if (source[i] === '{') depth += 1;
      else if (source[i] === '}') {
        depth -= 1;
        if (depth === 0) {
          end = i;
          break;
        }
      }
    }
    calls.push({
      line: source.slice(0, match.index).split('\n').length,
      options: source.slice(open, end + 1),
    });
  }
  return calls;
}

function overrides(source: string): number[] {
  return toastCalls(source)
    .filter((c) => FORBIDDEN_OPTION.test(c.options) || FORBIDDEN_VALUE.test(c.options))
    .map((c) => c.line);
}

describe('toast call sites', () => {
  it('finds the toast calls it scans', () => {
    const count = FRONTEND_SRC.flatMap(sourceFiles).reduce(
      (n, file) => n + toastCalls(readFileSync(file, 'utf8')).length,
      0,
    );
    expect(count).toBeGreaterThan(50);
  });

  it('flags a call that sets an infinite, zero or persistent duration', () => {
    expect(overrides("toast({ title: 'a', duration: Infinity });")).toEqual([1]);
    expect(overrides("toast({\n  title: 'a',\n  duration: 0,\n});")).toEqual([1]);
    expect(overrides("x;\ntoast({ title: t('a', { n: 1 }), persistent: true });")).toEqual([2]);
    expect(overrides("toast({ title: 'a', variant: 'destructive' });")).toEqual([]);
  });

  it('no CSMS or portal toast sets its own duration', () => {
    const found: string[] = [];
    for (const file of FRONTEND_SRC.flatMap(sourceFiles)) {
      for (const line of overrides(readFileSync(file, 'utf8'))) {
        found.push(`${path.relative(PACKAGES_DIR, file)}:${String(line)}`);
      }
    }
    expect(found).toEqual([]);
  });
});
