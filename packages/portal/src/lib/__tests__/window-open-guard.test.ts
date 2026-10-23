// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { describe, expect, it } from 'vitest';

// Every portal source file except tests.
const SOURCES = import.meta.glob<string>(['../../**/*.{ts,tsx}', '!**/__tests__/**'], {
  query: '?raw',
  import: 'default',
  eager: true,
});

// A page opened in a new tab never gets `window.opener` (reverse
// tabnabbing) or the portal URL as referrer, presigned downloads included.
describe('window.open in the portal', () => {
  it("always passes 'noopener,noreferrer'", () => {
    const calls: string[] = [];
    for (const [file, source] of Object.entries(SOURCES)) {
      for (const match of source.matchAll(/window\.open\(([^)]*)\)/g)) {
        calls.push(`${file}: ${match[1] ?? ''}`);
      }
    }
    expect(calls.length).toBeGreaterThan(0);
    expect(calls.filter((c) => !c.includes("'noopener,noreferrer'"))).toEqual([]);
  });
});
