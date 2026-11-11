// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { describe, expect, it } from 'vitest';
import source from '../PopularTimesChart.tsx?raw';

describe('Popular Times day picker', () => {
  it('is the shared compact SegmentedControl across the full width, so seven days fit a phone', () => {
    expect(source).toContain('<SegmentedControl');
    expect(source).toContain('size="compact"');
    expect(source).toContain('className="w-full"');
    expect(source).toContain("aria-label={t('charts.popularTimesDay')}");
    // No hand-built day buttons left.
    expect(source).not.toContain('<button');
  });
});
