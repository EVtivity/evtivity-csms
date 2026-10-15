// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { describe, it, expect } from 'vitest';
import { buttonVariants } from '../ui/button';

describe('buttonVariants disabled styles', () => {
  // An opacity layer on a filled button is rasterized per tile in Chromium and shows
  // vertical seams, so filled variants fade their colors instead.
  it.each([
    ['default', 'disabled:bg-primary/50'],
    ['destructive', 'disabled:bg-destructive/50'],
    ['success', 'disabled:bg-success/50'],
    ['secondary', 'disabled:bg-secondary/50'],
  ] as const)('%s fades its fill without opacity', (variant, fade) => {
    const classes = buttonVariants({ variant }).split(' ');
    expect(classes).toContain(fade);
    expect(classes).not.toContain('disabled:opacity-50');
    expect(classes).toContain('disabled:pointer-events-none');
  });

  it.each(['outline', 'ghost', 'link'] as const)('%s keeps the opacity fade', (variant) => {
    expect(buttonVariants({ variant }).split(' ')).toContain('disabled:opacity-50');
  });
});

describe('buttonVariants sizes', () => {
  it.each([
    ['header', ['h-11', 'grow', 'sm:h-10', 'sm:grow-0']],
    ['icon-header', ['h-11', 'w-11', 'sm:h-10', 'sm:w-10']],
    ['inline', ['h-auto', 'p-0', 'text-xs']],
    ['sm', ['h-10', 'px-3']],
    ['xs', ['h-7', 'text-xs']],
    ['icon-sm', ['h-8', 'w-8']],
    ['icon-xs', ['h-6', 'w-6']],
    ['chip', ['h-6', 'rounded-full', 'text-xs']],
    ['row', ['h-auto', 'w-full', 'justify-start', 'text-left']],
    ['row-sm', ['h-auto', 'w-full', 'justify-start', 'text-xs']],
    ['fab', ['h-12', 'w-12', 'rounded-full', 'shadow-lg']],
  ] as const)('%s has its shared classes and keeps the focus ring', (size, expected) => {
    const classes = buttonVariants({ size }).split(' ');
    for (const c of expected) expect(classes).toContain(c);
    expect(classes).toContain('focus-visible:ring-2');
  });
});
