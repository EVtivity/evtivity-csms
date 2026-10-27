// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { describe, expect, it } from 'vitest';
import source from '../PopularTimesChart.tsx?raw';

describe('Popular Times day picker on phones', () => {
  it('fits the seven days in one row', () => {
    expect(source).toContain('<div className="grid grid-cols-7 gap-1 sm:flex">');
    expect(source).toContain('min-w-0 rounded-md py-1');
    // Fixed padding pushed Saturday past a 360 px screen.
    expect(source).not.toContain('px-2 py-1 text-xs');
  });
});
