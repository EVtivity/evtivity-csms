// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { describe, expect, it } from 'vitest';

/**
 * Lists and tables page with the shared `Pagination` (Prev, Next, "Page N of
 * M"), never with a "Load More" button or infinite scroll (owner rule
 * 2026-10-27, `frontend/ui.md`). This scans every CSMS and portal source file
 * and the English locales for the infinite paging hooks and a load more
 * control.
 */

// Every CSMS and portal source file except tests.
const CSMS_SOURCES = import.meta.glob<string>(['../../**/*.{ts,tsx}', '!**/__tests__/**'], {
  query: '?raw',
  import: 'default',
  eager: true,
});
const PORTAL_SOURCES = import.meta.glob<string>(
  ['../../../../portal/src/**/*.{ts,tsx}', '!**/__tests__/**'],
  { query: '?raw', import: 'default', eager: true },
);
const LOCALES = import.meta.glob<string>(
  ['../../i18n/locales/en.json', '../../../../portal/src/i18n/locales/en.json'],
  { query: '?raw', import: 'default', eager: true },
);

/**
 * Files allowed to page without `Pagination`, each with the reason. Only for
 * what is not a list or table, such as an AI chat message history or a live
 * stream. Today none does.
 */
const ALLOWED: Record<string, string> = {};

const FORBIDDEN: Array<{ name: string; pattern: RegExp }> = [
  { name: 'useInfiniteQuery', pattern: /\buse(Suspense)?InfiniteQuery\b/ },
  { name: 'fetchNextPage', pattern: /\bfetch(Next|Previous)Page\b/ },
  { name: 'IntersectionObserver', pattern: /\bIntersectionObserver\b/ },
  { name: 'load more', pattern: /\bload[-_ ]?more\b/i },
];

function findings(sources: Record<string, string>): string[] {
  const found: string[] = [];
  for (const [file, source] of Object.entries(sources)) {
    if (Object.hasOwn(ALLOWED, file)) continue;
    for (const { name, pattern } of FORBIDDEN) {
      if (pattern.test(source)) found.push(`${file}: ${name}`);
    }
  }
  return found;
}

describe('list paging', () => {
  it('finds the source files to scan', () => {
    expect(Object.keys(CSMS_SOURCES).length).toBeGreaterThan(100);
    expect(Object.keys(PORTAL_SOURCES).length).toBeGreaterThan(20);
    expect(Object.keys(LOCALES)).toHaveLength(2);
  });

  it('uses no infinite paging or load more control in the CSMS or the portal', () => {
    expect(findings({ ...CSMS_SOURCES, ...PORTAL_SOURCES })).toEqual([]);
  });

  it('has no Load More or Show More text', () => {
    const texts: string[] = [];
    for (const [file, raw] of Object.entries(LOCALES)) {
      for (const match of raw.matchAll(
        /"([^"]+)":\s*"((?:load|show|see) (?:more|older|earlier))"/gi,
      )) {
        texts.push(`${file}: ${match[1] ?? ''}`);
      }
    }
    expect(texts).toEqual([]);
  });

  it('lists only allowed files that still exist', () => {
    const all = { ...CSMS_SOURCES, ...PORTAL_SOURCES };
    expect(Object.keys(ALLOWED).filter((file) => !Object.hasOwn(all, file))).toEqual([]);
  });
});
