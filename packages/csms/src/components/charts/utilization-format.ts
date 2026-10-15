// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { formatNumberUpTo } from '@/lib/formatting';

/**
 * Bar lengths relative to the busiest site (it gets 100), so a lightly used
 * network does not draw slivers. The real values go in the tooltip.
 */
export function relativeBarLengths(values: readonly number[]): number[] {
  const top = Math.max(0, ...values);
  return values.map((v) => (top > 0 ? (v / top) * 100 : 0));
}

/** A percent to two decimals; a value above zero that rounds to 0 reads "<0.01%". */
export function formatUtilizationPercent(value: number): string {
  if (value > 0 && value < 0.005) return `<${formatNumberUpTo(0.01, 2)}%`;
  return `${formatNumberUpTo(value, 2)}%`;
}
