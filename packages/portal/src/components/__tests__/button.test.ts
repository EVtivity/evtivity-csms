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

describe('buttonVariants text color', () => {
  // A filled or bordered button carries its own text color, so a tinted container (the
  // warning Alert, a status card) never colors its label.
  it.each([
    ['default', 'text-primary-foreground'],
    ['destructive', 'text-destructive-foreground'],
    ['outline', 'text-foreground'],
    ['secondary', 'text-secondary-foreground'],
    ['link', 'text-link'],
  ] as const)('%s sets %s', (variant, color) => {
    expect(buttonVariants({ variant }).split(' ')).toContain(color);
  });
});
