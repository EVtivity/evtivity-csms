// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { describe, expect, it } from 'vitest';
import source from '../Sites.tsx?raw';

describe('Sites filter bar', () => {
  it('keeps the search and every filter on one row on desktop', () => {
    const fieldCount = (source.match(/<Label className="leading-6">/g) ?? []).length;
    const grid = /grid flex-1 grid-cols-1 gap-4 md:grid-cols-(\d+)/.exec(source);
    expect(fieldCount).toBe(4);
    expect(Number(grid?.[1])).toBe(fieldCount);
  });
});
