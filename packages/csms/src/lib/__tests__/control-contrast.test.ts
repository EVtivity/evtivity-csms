// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { describe, expect, it } from 'vitest';
import csmsCss from '../../index.css?raw';
import portalCss from '../../../../portal/src/index.css?raw';
import buttonSource from '../../components/ui/button.tsx?raw';

/**
 * Button boundaries stand out from the surfaces they sit on (WCAG 2.2 SC
 * 1.4.11, at least 3:1): the `--control` token that outline and secondary
 * buttons use for their border, against card and page background, in both
 * themes, in the CSMS and the portal.
 */

type Hsl = [number, number, number];

function rgb([h, s, l]: Hsl): [number, number, number] {
  const sat = s / 100;
  const light = l / 100;
  const k = (n: number): number => (n + h / 30) % 12;
  const a = sat * Math.min(light, 1 - light);
  const f = (n: number): number =>
    light - a * Math.max(-1, Math.min(k(n) - 3, Math.min(9 - k(n), 1)));
  return [f(0), f(8), f(4)];
}

function luminance(color: Hsl): number {
  const c = (v: number): number => (v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4);
  const [r, g, b] = rgb(color);
  return 0.2126 * c(r) + 0.7152 * c(g) + 0.0722 * c(b);
}

function contrast(x: Hsl, y: Hsl): number {
  const [a, b] = [luminance(x), luminance(y)].sort((p, q) => q - p) as [number, number];
  return (a + 0.05) / (b + 0.05);
}

function tokens(css: string, selector: ':root' | '.dark'): Record<string, Hsl> {
  const block = new RegExp(`\\n  ${selector.replace('.', '\\.')} \\{([^}]*--card:[^}]*)\\}`).exec(
    css,
  )?.[1];
  if (block == null) throw new Error(`no ${selector} token block`);
  const out: Record<string, Hsl> = {};
  for (const m of block.matchAll(/--([a-z-]+):\s*([\d.]+)\s+([\d.]+)%\s+([\d.]+)%;/g)) {
    out[m[1] as string] = [Number(m[2]), Number(m[3]), Number(m[4])];
  }
  return out;
}

const FILES = { csms: csmsCss, portal: portalCss };

const SOURCES: Record<string, string> = {
  ...import.meta.glob(['/src/**/*.{ts,tsx}', '!/src/**/__tests__/**'], {
    query: '?raw',
    import: 'default',
    eager: true,
  }),
  ...import.meta.glob(['../../../../portal/src/**/*.{ts,tsx}', '!**/__tests__/**'], {
    query: '?raw',
    import: 'default',
    eager: true,
  }),
};

describe('control boundary contrast', () => {
  for (const [app, css] of Object.entries(FILES)) {
    for (const selector of [':root', '.dark'] as const) {
      it(`${app} ${selector}: --control is at least 3:1 against card and background`, () => {
        const t = tokens(css, selector);
        const control = t['control'];
        expect(control).toBeDefined();
        for (const surface of ['card', 'background']) {
          const value = t[surface];
          expect(value).toBeDefined();
          expect(contrast(control as Hsl, value as Hsl)).toBeGreaterThanOrEqual(3);
        }
      });
    }
  }

  for (const [app, css] of Object.entries(FILES)) {
    for (const selector of [':root', '.dark'] as const) {
      it(`${app} ${selector}: input borders 3:1, primary fill 3:1 and its text 4.5:1, links 4.5:1 on card, background, muted and accent`, () => {
        const t = tokens(css, selector);
        for (const surface of ['card', 'background'] as const) {
          expect(contrast(t['input'] as Hsl, t[surface] as Hsl)).toBeGreaterThanOrEqual(3);
          expect(contrast(t['primary'] as Hsl, t[surface] as Hsl)).toBeGreaterThanOrEqual(3);
          expect(contrast(t['link'] as Hsl, t[surface] as Hsl)).toBeGreaterThanOrEqual(4.5);
        }
        for (const surface of ['muted', 'accent'] as const) {
          expect(contrast(t['link'] as Hsl, t[surface] as Hsl)).toBeGreaterThanOrEqual(4.5);
        }
        expect(
          contrast(t['primary-foreground'] as Hsl, t['primary'] as Hsl),
        ).toBeGreaterThanOrEqual(4.5);
      });
    }
  }

  it('no source draws text with text-primary (the dark fill is below 4.5:1 as text)', () => {
    const paths = Object.keys(SOURCES);
    expect(paths.some((p) => p.includes('/portal/src/'))).toBe(true);
    expect(paths.length).toBeGreaterThan(200);
    const offenders = Object.entries(SOURCES)
      .filter(([, source]) => /text-primary(?![-\w])/.test(source))
      .map(([path]) => path);
    expect(offenders).toEqual([]);
  });

  it('the outline and secondary button variants draw their border with --control', () => {
    const button = buttonSource;
    expect(button).toMatch(/outline:\s*\n?\s*'border border-control /);
    expect(button).toMatch(/secondary:\s*\n?\s*'border border-control /);
  });
});
