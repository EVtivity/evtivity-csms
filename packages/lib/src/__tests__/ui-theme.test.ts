// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  DEFAULT_UI_THEME,
  UI_THEMES,
  applyUiThemeToRoot,
  isUiTheme,
  toUiTheme,
} from '../ui-theme.js';
import {
  UI_COLOR_TOKENS,
  UI_CONTRAST_PAIRS,
  UI_SHAPE_TOKENS,
  UI_THEME_TOKENS,
  UI_TINT_ALPHA,
  UI_TINT_TEXT_PAIRS,
  contrastOnTint,
  contrastRatio,
  renderThemeCss,
  requiredContrast,
  themeSelector,
} from '../ui-theme-tokens.js';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../../../..');

describe('ui theme ids', () => {
  it('lists the three themes with Default first', () => {
    expect(UI_THEMES).toEqual(['default', 'soft', 'high-contrast']);
    expect(DEFAULT_UI_THEME).toBe('default');
  });

  it('reads unknown values as the default theme', () => {
    expect(isUiTheme('soft')).toBe(true);
    expect(isUiTheme('system')).toBe(false);
    expect(toUiTheme('high-contrast')).toBe('high-contrast');
    expect(toUiTheme(null)).toBe('default');
    expect(toUiTheme('neon')).toBe('default');
  });

  it('sets the dark class and data-theme only for a theme other than Default', () => {
    const classes = new Set<string>();
    const attrs = new Map<string, string>();
    const root = {
      classList: {
        toggle: (name: string, on: boolean) => (on ? classes.add(name) : classes.delete(name)),
        contains: (name: string) => classes.has(name),
      },
      setAttribute: (name: string, value: string) => attrs.set(name, value),
      removeAttribute: (name: string) => attrs.delete(name),
      getAttribute: (name: string) => attrs.get(name) ?? null,
      hasAttribute: (name: string) => attrs.has(name),
    } as unknown as HTMLElement;
    applyUiThemeToRoot(root, 'soft', 'dark');
    expect(root.classList.contains('dark')).toBe(true);
    expect(root.getAttribute('data-theme')).toBe('soft');
    applyUiThemeToRoot(root, 'default', 'light');
    expect(root.classList.contains('dark')).toBe(false);
    expect(root.hasAttribute('data-theme')).toBe(false);
  });
});

describe('ui theme tokens', () => {
  it('gives every theme and mode the full token set', () => {
    for (const theme of UI_THEMES) {
      for (const mode of ['light', 'dark'] as const) {
        const tokens = UI_THEME_TOKENS[theme][mode];
        for (const name of [...UI_COLOR_TOKENS, ...UI_SHAPE_TOKENS]) {
          expect(tokens[name], `${theme} ${mode} ${name}`).toMatch(/\S/);
        }
      }
    }
  });

  it('keeps Default on the plain :root and .dark selectors', () => {
    expect(themeSelector('default', 'light')).toBe(':root');
    expect(themeSelector('default', 'dark')).toBe('.dark');
    expect(themeSelector('soft', 'dark')).toBe(":root.dark[data-theme='soft']");
  });

  it('keeps the Default values the apps used before themes, apart from the tone colors', () => {
    const light = UI_THEME_TOKENS.default.light;
    expect(light.primary).toBe('221.2 83.2% 53.3%');
    expect(light.border).toBe('214.3 31.8% 91.4%');
    expect(light.radius).toBe('0.5rem');
    expect(UI_THEME_TOKENS.default.dark.card).toBe('217.2 32.6% 11%');
    expect(UI_THEME_TOKENS.default.dark['ui-font-weight-medium']).toBe('500');
  });

  it('makes Soft rounder with lighter borders and High Contrast untinted', () => {
    expect(UI_THEME_TOKENS.soft.light.radius).not.toBe(UI_THEME_TOKENS.default.light.radius);
    for (const mode of ['light', 'dark'] as const) {
      const hc = UI_THEME_TOKENS['high-contrast'][mode];
      for (const surface of [
        'background',
        'card',
        'popover',
        'muted',
        'secondary',
        'accent',
      ] as const) {
        expect(hc[surface], `${mode} ${surface}`).toMatch(/^0 0% /);
      }
    }
  });
});

describe('ui theme contrast (WCAG 2.2)', () => {
  it('computes known ratios', () => {
    expect(contrastRatio('0 0% 0%', '0 0% 100%')).toBeCloseTo(21, 5);
    expect(contrastRatio('0 0% 50%', '0 0% 50%')).toBeCloseTo(1, 5);
  });

  for (const theme of UI_THEMES) {
    for (const mode of ['light', 'dark'] as const) {
      it(`${theme} ${mode}: every text pair meets AA, body text AAA in High Contrast`, () => {
        const tokens = UI_THEME_TOKENS[theme][mode];
        const failing: string[] = [];
        for (const pair of UI_CONTRAST_PAIRS) {
          const ratio = contrastRatio(tokens[pair.fg], tokens[pair.bg]);
          if (ratio < requiredContrast(theme, pair.kind)) failing.push(`${pair.fg}/${pair.bg}`);
        }
        expect(failing).toEqual([]);
      });
    }
  }

  it('splits warning into a bright fill and a darker text color in light mode', () => {
    for (const theme of UI_THEMES) {
      const light = UI_THEME_TOKENS[theme].light;
      // The fill is the bright amber (not brown) and carries dark text.
      expect(light.warning, theme).toBe('37.7 92.1% 50%');
      expect(contrastRatio(light['warning-foreground'], light.warning)).toBeGreaterThanOrEqual(7);
      // Warning text and icons on the card and the page use the deep amber.
      expect(light['warning-text'], theme).not.toBe(light.warning);
    }
  });

  for (const theme of UI_THEMES) {
    for (const mode of ['light', 'dark'] as const) {
      it(`${theme} ${mode}: Alert text and muted text meet AA on every tone tint`, () => {
        const t = UI_THEME_TOKENS[theme][mode];
        const failing: string[] = [];
        for (const pair of UI_TINT_TEXT_PAIRS) {
          for (const surface of ['card', 'background'] as const) {
            const ratio = contrastOnTint(t[pair.fg], t[pair.tone], t[surface], UI_TINT_ALPHA);
            if (ratio < 4.5) failing.push(`${pair.fg} on ${pair.tone}/10 over ${surface}`);
          }
        }
        expect(failing).toEqual([]);
      });
    }
  }

  it('checks the focus ring and every tone text token', () => {
    const fgs = UI_CONTRAST_PAIRS.map((p) => `${p.fg}/${p.bg}`);
    for (const pair of ['ring/card', 'ring/background']) expect(fgs).toContain(pair);
    for (const tone of ['destructive', 'success', 'info', 'warning']) {
      expect(UI_TINT_TEXT_PAIRS.some((p) => p.fg === `${tone}-text`)).toBe(true);
      expect(UI_TINT_TEXT_PAIRS.some((p) => p.fg === 'muted-foreground' && p.tone === tone)).toBe(
        true,
      );
    }
  });

  it('asks AAA of body text in High Contrast only', () => {
    expect(requiredContrast('high-contrast', 'body')).toBe(7);
    expect(requiredContrast('default', 'body')).toBe(4.5);
    expect(requiredContrast('high-contrast', 'text')).toBe(4.5);
    expect(requiredContrast('soft', 'boundary')).toBe(3);
  });
});

describe('generated app themes.css', () => {
  for (const app of ['csms', 'portal']) {
    it(`packages/${app}/src/themes.css matches the token table (npm run codegen:themes)`, () => {
      const file = readFileSync(resolve(repoRoot, `packages/${app}/src/themes.css`), 'utf8');
      expect(file).toBe(renderThemeCss());
    });
  }
});
