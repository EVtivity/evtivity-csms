// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

/** A small deterministic generator, so a rerun of a demo seed plans the same rows. */
export function demoRandom(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4_294_967_296;
  };
}

/** A whole number from min to max, both included. */
export function demoBetween(rand: () => number, min: number, max: number): number {
  return min + Math.floor(rand() * (max - min + 1));
}
