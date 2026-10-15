// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { describe, expect, it } from 'vitest';
import { formatUtilizationPercent, relativeBarLengths } from '../utilization-format';

describe('relativeBarLengths', () => {
  it('gives the busiest site the full bar and scales the others to it', () => {
    expect(relativeBarLengths([0.48, 0.24, 0.12])).toEqual([100, 50, 25]);
  });

  it('draws no bars when every site is at zero', () => {
    expect(relativeBarLengths([0, 0])).toEqual([0, 0]);
    expect(relativeBarLengths([])).toEqual([]);
  });
});

describe('formatUtilizationPercent', () => {
  it('shows up to two decimals', () => {
    expect(formatUtilizationPercent(0.4791)).toBe('0.48%');
    expect(formatUtilizationPercent(75)).toBe('75%');
  });

  it('shows zero as 0%', () => {
    expect(formatUtilizationPercent(0)).toBe('0%');
  });

  it('marks a value above zero that rounds to zero as under 0.01%', () => {
    expect(formatUtilizationPercent(0.0035)).toBe('<0.01%');
  });
});
