// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

// Each scene module receives only the scene context members it declares
// (`SceneSlice<reads, writes>`). TypeScript refuses a member outside the slice;
// this test keeps the lists exact (no stale member, writes declared as writes)
// and refuses a module that widens back to the whole context.

import { describe, expect, it } from 'vitest';

const modules = import.meta.glob<string>('../site-layout-scene-*.ts', {
  query: '?raw',
  import: 'default',
  eager: true,
});

// Shared types and pure helpers, not modules that receive the context.
const NOT_MODULES = new Set(['context', 'types', 'station-slots']);

// The idle charger builder composes the modules on a context of its own.
function withoutComposition(src: string): string {
  const start = src.indexOf('export function buildIdleChargerModel');
  if (start < 0) return src;
  const end = src.indexOf('\n}\n', start);
  return src.slice(0, start) + src.slice(end + 3);
}

function slices(src: string): { reads: Set<string>; writes: Set<string> } {
  const reads = new Set<string>();
  const writes = new Set<string>();
  for (const m of src.matchAll(/SceneSlice</g)) {
    let depth = 1;
    let i = m.index + m[0].length;
    const from = i;
    while (depth > 0) {
      if (src[i] === '<') depth++;
      if (src[i] === '>') depth--;
      i++;
    }
    const [r = '', w = ''] = src.slice(from, i - 1).split(',');
    for (const k of r.matchAll(/'(\w+)'/g)) reads.add(k[1] ?? '');
    for (const k of w.matchAll(/'(\w+)'/g)) writes.add(k[1] ?? '');
  }
  return { reads, writes };
}

function usage(src: string): { reads: Set<string>; writes: Set<string> } {
  const used = new Set<string>();
  const writes = new Set<string>();
  for (const m of src.matchAll(/\bscn\.(\w+)/g)) used.add(m[1] ?? '');
  for (const m of src.matchAll(/\bscn\.(\w+)\s*(=(?!=)|\+=|-=|\?\?=|\|\|=|&&=|\+\+|--)/g)) {
    writes.add(m[1] ?? '');
  }
  return { reads: new Set([...used].filter((k) => !writes.has(k))), writes };
}

const entries = Object.entries(modules)
  .map(([path, src]) => ({
    name: path.replace(/^.*site-layout-scene-(.+)\.ts$/, '$1'),
    src: withoutComposition(src),
  }))
  .filter((e) => !NOT_MODULES.has(e.name));

describe('scene module context slices', () => {
  it('finds every scene module', () => {
    expect(entries.length).toBeGreaterThanOrEqual(18);
  });

  it.each(entries)('$name takes its own slice, never the whole context', ({ src }) => {
    const code = src
      .split('\n')
      .filter((line) => !line.startsWith('import '))
      .join('\n');
    expect(code).not.toMatch(/\bSceneCtx\b/);
    expect(src).toMatch(/export function install\w+\(scn: \w+Ctx\): void/);
  });

  it.each(entries)('$name declares exactly the members it reads and writes', ({ src }) => {
    const declared = slices(src);
    const used = usage(src);
    expect([...declared.reads].sort()).toEqual([...used.reads].sort());
    expect([...declared.writes].sort()).toEqual([...used.writes].sort());
  });
});
