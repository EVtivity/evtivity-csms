// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { describe, expect, it } from 'vitest';
import csmsCss from '../../themes.css?raw';
import { STATUS_ICON_COLORS, statusIconColor } from '../chart-theme';

/**
 * The 2D charger card (owner design 2026-11-03): its text (the ID, the
 * metrics line in foreground and muted) at least 4.5:1 and its icons (the
 * connection and terminal marks, the port pictograms in every status color)
 * at least 3:1 against the card, in both themes (WCAG 2.2 SC 1.4.3 and 1.4.11).
 */

type Rgb = [number, number, number];

function hslToRgb(h: number, s: number, l: number): Rgb {
  const sat = s / 100;
  const light = l / 100;
  const k = (n: number): number => (n + h / 30) % 12;
  const a = sat * Math.min(light, 1 - light);
  const f = (n: number): number =>
    light - a * Math.max(-1, Math.min(k(n) - 3, Math.min(9 - k(n), 1)));
  return [f(0), f(8), f(4)];
}

function hexToRgb(hex: string): Rgb {
  const v = parseInt(hex.slice(1), 16);
  return [((v >> 16) & 255) / 255, ((v >> 8) & 255) / 255, (v & 255) / 255];
}

function luminance([r, g, b]: Rgb): number {
  const c = (v: number): number => (v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4);
  return 0.2126 * c(r) + 0.7152 * c(g) + 0.0722 * c(b);
}

function contrast(x: Rgb, y: Rgb): number {
  const [a, b] = [luminance(x), luminance(y)].sort((p, q) => q - p) as [number, number];
  return (a + 0.05) / (b + 0.05);
}

function tokens(selector: ':root' | '.dark'): Record<string, Rgb> {
  const block = new RegExp(`\\n  ${selector.replace('.', '\\.')} \\{([^}]*--card:[^}]*)\\}`).exec(
    csmsCss,
  )?.[1];
  if (block == null) throw new Error(`no ${selector} token block`);
  const out: Record<string, Rgb> = {};
  for (const m of block.matchAll(/--([a-z-]+):\s*([\d.]+)\s+([\d.]+)%\s+([\d.]+)%;/g)) {
    out[m[1] as string] = hslToRgb(Number(m[2]), Number(m[3]), Number(m[4]));
  }
  return out;
}

const THEMES = [
  { name: 'light', selector: ':root', dark: false },
  { name: 'dark', selector: '.dark', dark: true },
] as const;

describe('2D charger card contrast', () => {
  for (const theme of THEMES) {
    const t = tokens(theme.selector);
    const card = t['card'] as Rgb;

    it(`keeps the card text at 4.5:1 or more (${theme.name})`, () => {
      for (const name of ['card-foreground', 'foreground', 'muted-foreground']) {
        expect(contrast(t[name] as Rgb, card), name).toBeGreaterThanOrEqual(4.5);
      }
    });

    it(`keeps the neutral icons at 3:1 or more (${theme.name})`, () => {
      expect(contrast(t['muted-foreground'] as Rgb, card)).toBeGreaterThanOrEqual(3);
    });

    it(`keeps every port and terminal icon color at 3:1 or more (${theme.name})`, () => {
      for (const status of Object.keys(STATUS_ICON_COLORS[theme.name])) {
        const ratio = contrast(hexToRgb(statusIconColor(status, theme.dark)), card);
        expect(ratio, status).toBeGreaterThanOrEqual(3);
      }
    });
  }
});
