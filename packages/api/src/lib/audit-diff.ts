// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

type Row = Record<string, unknown>;

function sameValue(a: unknown, b: unknown): boolean {
  if (a instanceof Date && b instanceof Date) return a.getTime() === b.getTime();
  if (a != null && b != null && typeof a === 'object' && typeof b === 'object') {
    return JSON.stringify(a) === JSON.stringify(b);
  }
  return a === b;
}

/**
 * The keys of `after` whose value differs from `before`, as a before/after
 * pair holding only those keys. `updatedAt` is left out: it changes on every
 * write and says nothing.
 */
export function changedFields(before: Row, after: Row): { before: Row; after: Row } {
  const b: Row = {};
  const a: Row = {};
  for (const key of Object.keys(after)) {
    if (key === 'updatedAt') continue;
    if (!sameValue(before[key], after[key])) {
      b[key] = before[key] ?? null;
      a[key] = after[key] ?? null;
    }
  }
  return { before: b, after: a };
}
