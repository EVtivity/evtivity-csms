// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { expect } from 'vitest';

/** Times one call, best of `repeats`, so a GC pause or a busy CPU does not count. */
function fastestRun(run: () => void, repeats: number): number {
  let best = Number.POSITIVE_INFINITY;
  for (let i = 0; i < repeats; i++) {
    const started = performance.now();
    run();
    best = Math.min(best, performance.now() - started);
  }
  return best;
}

/**
 * Asserts that `run` scales linearly with its input: the input built at
 * `GROWTH` times the size may take at most `MAX_RATIO` times as long as the
 * input at size 1 (a quadratic scan takes about GROWTH squared, 64 times).
 * Each size is timed as its fastest of several runs, so parallel test load
 * slows both sizes alike instead of failing a wall-clock limit. The base time
 * has a floor, so timer resolution on a very fast run cannot inflate the ratio.
 */
export function expectLinearTime(
  label: string,
  build: (scale: number) => string,
  run: (input: string) => void,
): void {
  const GROWTH = 8;
  const MAX_RATIO = 24;
  const BASE_FLOOR_MS = 0.5;
  const REPEATS = 5;
  const small = build(1);
  const large = build(GROWTH);
  run(small);
  run(large);
  const smallMs = fastestRun(() => {
    run(small);
  }, REPEATS);
  const largeMs = fastestRun(() => {
    run(large);
  }, REPEATS);
  expect(
    largeMs,
    `${label}: ${String(large.length)} chars took ${largeMs.toFixed(2)} ms, ${String(small.length)} chars ${smallMs.toFixed(2)} ms`,
  ).toBeLessThan(MAX_RATIO * Math.max(smallMs, BASE_FLOOR_MS));
}
