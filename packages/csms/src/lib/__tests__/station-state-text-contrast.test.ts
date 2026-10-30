// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { describe, expect, it } from 'vitest';
import csmsCss from '../../index.css?raw';
import {
  STATION_DISPLAY_STATES,
  STATION_STATE_TEXT_MIX,
  stationStateColor,
  stationStateTextColor,
} from '../station-display-state';

/**
 * The state word in the 3D layout labels (`stationStateTextColor`: the state
 * color mixed in sRGB with the card foreground) reads at least 4.5:1 on the
 * card in both themes (WCAG 2.2 SC 1.4.3).
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
  return [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255) as Rgb;
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

function resolve(color: string, t: Record<string, Rgb>): Rgb {
  if (color.startsWith('#')) return hexToRgb(color);
  const token = /^hsl\(var\(--([a-z-]+)\)\)$/.exec(color)?.[1];
  const rgb = token != null ? t[token] : undefined;
  if (rgb == null) throw new Error(`unknown color ${color}`);
  return rgb;
}

describe('station state text contrast', () => {
  it('mixes the state color with the card foreground', () => {
    expect(stationStateTextColor('charging')).toBe(
      `color-mix(in srgb, ${stationStateColor('charging')} ${String(STATION_STATE_TEXT_MIX)}%, hsl(var(--card-foreground)))`,
    );
  });

  for (const selector of [':root', '.dark'] as const) {
    it(`${selector}: every state word is at least 4.5:1 on the card`, () => {
      const t = tokens(selector);
      const card = t['card'];
      const fg = t['card-foreground'];
      if (card == null || fg == null) throw new Error('missing card tokens');
      const p = STATION_STATE_TEXT_MIX / 100;
      for (const state of STATION_DISPLAY_STATES) {
        const color = resolve(stationStateColor(state), t);
        const mixed = color.map((v, i) => v * p + (fg[i] ?? 0) * (1 - p)) as Rgb;
        expect(contrast(mixed, card), `${selector} ${state}`).toBeGreaterThanOrEqual(4.5);
      }
    });
  }
});
