// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { DEFAULT_UI_THEME, UI_THEMES, type UiMode, type UiTheme } from './ui-theme.js';

/**
 * The design tokens of every UI theme, the one source of the CSS variables the
 * CSMS and the portal read (`--background`, `--primary`, `--radius`, ...).
 * `renderThemeCss()` writes them to each app's generated `src/themes.css`
 * (`npm run codegen:themes`); a lib test fails when a generated file differs.
 *
 * Colors are HSL triplets without `hsl()` ("221.2 83.2% 53.3%"), as the apps'
 * Tailwind theme wraps them (`--color-primary: hsl(var(--primary))`). The
 * Default tokens are the values the apps used before themes, with the tone
 * colors and their foregrounds moved to WCAG AA (owner decision 2026-11-11).
 */
export const UI_COLOR_TOKENS = [
  'background',
  'foreground',
  'card',
  'card-foreground',
  'popover',
  'popover-foreground',
  'primary',
  'primary-foreground',
  'link',
  'secondary',
  'secondary-foreground',
  'muted',
  'muted-foreground',
  'accent',
  'accent-foreground',
  'destructive',
  'destructive-foreground',
  'destructive-text',
  'success',
  'success-foreground',
  'success-text',
  'warning',
  'warning-foreground',
  'warning-text',
  'info',
  'info-foreground',
  'info-text',
  'border',
  'input',
  'control',
  'on-tone',
  'ring',
] as const;

export type UiColorToken = (typeof UI_COLOR_TOKENS)[number];

/** Tokens that are not colors: corner radius, shadows and font weights. */
export const UI_SHAPE_TOKENS = [
  'radius',
  'ui-shadow-xs',
  'ui-shadow-sm',
  'ui-shadow-md',
  'ui-shadow-lg',
  'ui-font-weight-normal',
  'ui-font-weight-medium',
  'ui-font-weight-semibold',
  'ui-font-weight-bold',
] as const;

export type UiShapeToken = (typeof UI_SHAPE_TOKENS)[number];

export type UiTokenSet = Record<UiColorToken | UiShapeToken, string>;

const DEFAULT_SHAPE: Record<UiShapeToken, string> = {
  radius: '0.5rem',
  // The Tailwind 4 default shadows, so Default stays as it was.
  'ui-shadow-xs': '0 1px 2px 0 rgb(0 0 0 / 0.05)',
  'ui-shadow-sm': '0 1px 3px 0 rgb(0 0 0 / 0.1), 0 1px 2px -1px rgb(0 0 0 / 0.1)',
  'ui-shadow-md': '0 4px 6px -1px rgb(0 0 0 / 0.1), 0 2px 4px -2px rgb(0 0 0 / 0.1)',
  'ui-shadow-lg': '0 10px 15px -3px rgb(0 0 0 / 0.1), 0 4px 6px -4px rgb(0 0 0 / 0.1)',
  'ui-font-weight-normal': '400',
  'ui-font-weight-medium': '500',
  'ui-font-weight-semibold': '600',
  'ui-font-weight-bold': '700',
};

const DEFAULT_LIGHT: UiTokenSet = {
  background: '210 40% 98%',
  foreground: '222.2 84% 4.9%',
  card: '0 0% 100%',
  'card-foreground': '222.2 84% 4.9%',
  popover: '0 0% 100%',
  'popover-foreground': '222.2 84% 4.9%',
  primary: '221.2 83.2% 53.3%',
  'primary-foreground': '210 40% 98%',
  // Text and links in the brand color (text-link): 5.2:1 on card, 4.9:1 on background.
  link: '221.2 83.2% 53.3%',
  secondary: '210 40% 96.1%',
  'secondary-foreground': '222.2 47.4% 11.2%',
  muted: '210 40% 96.1%',
  // Muted text stays at AA on the 10 percent tone tints of Alert too (4.6:1 on the
  // destructive tint over the page, the lowest).
  'muted-foreground': '215.4 16.3% 42%',
  accent: '210 40% 96.1%',
  'accent-foreground': '222.2 47.4% 11.2%',
  // Tone colors serve as text on card and background and as fills under light
  // text, so each sits at WCAG AA both ways (owner decision 2026-11-11): text on
  // card 4.9:1 to 5:1, on background and light text on the fill 4.6:1 to 4.7:1.
  destructive: '0 84.2% 48%',
  'destructive-foreground': '210 40% 98%',
  // Alert text and icons on the 10 percent tone tint: at least 4.5:1 over card and
  // background, a little deeper than the tone (the tint lowers the contrast).
  'destructive-text': '0 84.2% 44%',
  success: '160 84% 27.5%',
  'success-foreground': '210 40% 98%',
  'success-text': '160 84% 25.5%',
  // Warning splits into a fill and a text color (owner decision 2026-11-12):
  // the fill stays a bright amber under dark text (9.3:1), and warning text and
  // icons on card and background use the deep amber `warning-text` (5.5:1 on
  // card, 5.3:1 on background, 4.9:1 on the 10 percent warning tint of Alert).
  warning: '37.7 92.1% 50%',
  'warning-foreground': '222.2 84% 4.9%',
  'warning-text': '26 90% 35%',
  info: '189 94.5% 29%',
  'info-foreground': '210 40% 98%',
  'info-text': '189 94.5% 27%',
  border: '214.3 31.8% 91.4%',
  // Form control and button boundaries: 3.3:1 on card, 3.2:1 on background (WCAG 1.4.11).
  input: '215 16% 57%',
  control: '215 16% 57%',
  // Icon ink on solid tone fills (IconBadge): at least 4:1 on info, destructive and
  // success. A warning badge uses `warning-foreground`, the ink of its fill.
  'on-tone': '222.2 84% 4.9%',
  ring: '221.2 83.2% 53.3%',
  ...DEFAULT_SHAPE,
};

const DEFAULT_DARK: UiTokenSet = {
  background: '222.2 84% 4.9%',
  foreground: '210 40% 98%',
  card: '217.2 32.6% 11%',
  'card-foreground': '210 40% 98%',
  popover: '217.2 32.6% 11%',
  'popover-foreground': '210 40% 98%',
  // Primary fill: white text 4.8:1, fill on card 3.5:1.
  primary: '217 91% 50%',
  'primary-foreground': '210 40% 98%',
  // Text and links in the brand color: 5.7:1 on card, 6.5:1 on background.
  link: '217.2 91.2% 65%',
  secondary: '217.2 32.6% 17.5%',
  'secondary-foreground': '210 40% 98%',
  muted: '217.2 32.6% 17.5%',
  'muted-foreground': '215 20.2% 65.1%',
  accent: '217.2 32.6% 17.5%',
  'accent-foreground': '210 40% 98%',
  // red-500: error text stays readable on the dark background (5.3:1).
  destructive: '0 84.2% 60.2%',
  // Dark text on the tone fills (WCAG AA, owner decision 2026-11-11): 5.3:1 on
  // destructive and info, 10.3:1 on success, 9.3:1 on warning.
  'destructive-foreground': '222.2 84% 4.9%',
  // Alert text on the 10 percent tone tint, lighter than the tone: at least 4.5:1.
  'destructive-text': '0 84.2% 64%',
  success: '160 84% 45%',
  'success-foreground': '222.2 84% 4.9%',
  'success-text': '160 84% 45%',
  // The bright amber fill, and the same amber as text: 8.1:1 on card, 9.3:1 on background.
  warning: '37.7 92.1% 50%',
  'warning-foreground': '222.2 84% 4.9%',
  'warning-text': '37.7 92.1% 50%',
  // Info text on card 4.6:1.
  info: '189 94.5% 34%',
  'info-foreground': '222.2 84% 4.9%',
  'info-text': '189 94.5% 37%',
  border: '217.2 32.6% 17.5%',
  // Form control and button boundaries: 3.4:1 on card, 3.9:1 on background (WCAG 1.4.11).
  input: '215 20% 45%',
  control: '215 20% 45%',
  'on-tone': '222.2 84% 4.9%',
  // The focus ring is the primary fill: 3.5:1 on card, 3.9:1 on background (WCAG 1.4.11).
  ring: '217 91% 50%',
  ...DEFAULT_SHAPE,
};

// Soft: rounder corners, lighter dividers, softer and wider shadows. Colors of
// text and fills stay those of Default; the form control boundary keeps its
// 3:1 (WCAG 1.4.11), only the decorative divider (`--border`) is lighter.
const SOFT_SHAPE: Partial<UiTokenSet> = {
  radius: '0.875rem',
  'ui-shadow-xs': '0 1px 3px 0 rgb(15 23 42 / 0.04)',
  'ui-shadow-sm': '0 2px 6px -1px rgb(15 23 42 / 0.06), 0 1px 3px -1px rgb(15 23 42 / 0.04)',
  'ui-shadow-md': '0 6px 16px -4px rgb(15 23 42 / 0.08), 0 2px 6px -2px rgb(15 23 42 / 0.05)',
  'ui-shadow-lg': '0 16px 32px -8px rgb(15 23 42 / 0.1), 0 6px 12px -6px rgb(15 23 42 / 0.06)',
};

// Soft keeps its own tone fills, deeper and under white text, except warning,
// whose fill is the bright amber under dark text with a deep amber text color.
const SOFT_LIGHT: UiTokenSet = {
  ...DEFAULT_LIGHT,
  ...SOFT_SHAPE,
  border: '214.3 31.8% 94.5%',
  destructive: '0 72% 46%',
  'destructive-foreground': '0 0% 100%',
  'destructive-text': '0 72% 45%',
  success: '160 84% 26%',
  'success-foreground': '0 0% 100%',
  'success-text': '160 84% 25.5%',
  warning: '37.7 92.1% 50%',
  'warning-foreground': '222.2 84% 4.9%',
  'warning-text': '26 90% 35%',
  info: '192 90% 30%',
  'info-foreground': '0 0% 100%',
  'info-text': '192 90% 29%',
  'on-tone': '0 0% 100%',
};

const SOFT_DARK: UiTokenSet = {
  ...DEFAULT_DARK,
  ...SOFT_SHAPE,
  border: '217.2 32.6% 14.5%',
  'destructive-foreground': '222.2 84% 4.9%',
  'success-foreground': '222.2 84% 4.9%',
  warning: '37.7 92.1% 50%',
  'warning-foreground': '222.2 84% 4.9%',
  'warning-text': '37.7 92.1% 50%',
  info: '189 94.5% 43%',
  'info-foreground': '222.2 84% 4.9%',
  'info-text': '189 94.5% 43%',
};

// High Contrast: neutral surfaces with no hue tint, black or white text at
// AAA (7:1), strong borders and control boundaries, tone fills dark enough (light
// mode) or light enough (dark mode) for their text at AAA (the light warning fill
// is the bright amber under black text), heavier text weights.
const HIGH_CONTRAST_SHAPE: Partial<UiTokenSet> = {
  'ui-font-weight-medium': '600',
  'ui-font-weight-semibold': '700',
  'ui-font-weight-bold': '700',
};

const HIGH_CONTRAST_LIGHT: UiTokenSet = {
  ...DEFAULT_LIGHT,
  ...HIGH_CONTRAST_SHAPE,
  background: '0 0% 100%',
  foreground: '0 0% 0%',
  card: '0 0% 100%',
  'card-foreground': '0 0% 0%',
  popover: '0 0% 100%',
  'popover-foreground': '0 0% 0%',
  primary: '221 83% 35%',
  'primary-foreground': '0 0% 100%',
  link: '221 83% 33%',
  secondary: '0 0% 93%',
  'secondary-foreground': '0 0% 0%',
  muted: '0 0% 93%',
  'muted-foreground': '0 0% 20%',
  accent: '0 0% 90%',
  'accent-foreground': '0 0% 0%',
  destructive: '0 85% 30%',
  'destructive-foreground': '0 0% 100%',
  'destructive-text': '0 85% 30%',
  success: '160 90% 18%',
  'success-foreground': '0 0% 100%',
  'success-text': '160 90% 18%',
  // Bright amber fill under black text (9.8:1), deep amber warning text (9.4:1).
  warning: '37.7 92.1% 50%',
  'warning-foreground': '0 0% 0%',
  'warning-text': '30 95% 22%',
  info: '200 95% 22%',
  'info-foreground': '0 0% 100%',
  'info-text': '200 95% 22%',
  border: '0 0% 35%',
  input: '0 0% 20%',
  control: '0 0% 20%',
  'on-tone': '0 0% 100%',
  ring: '221 83% 35%',
};

const HIGH_CONTRAST_DARK: UiTokenSet = {
  ...DEFAULT_DARK,
  ...HIGH_CONTRAST_SHAPE,
  background: '0 0% 0%',
  foreground: '0 0% 100%',
  card: '0 0% 5%',
  'card-foreground': '0 0% 100%',
  popover: '0 0% 5%',
  'popover-foreground': '0 0% 100%',
  primary: '217 91% 72%',
  'primary-foreground': '0 0% 0%',
  link: '217 91% 76%',
  secondary: '0 0% 14%',
  'secondary-foreground': '0 0% 100%',
  muted: '0 0% 14%',
  'muted-foreground': '0 0% 85%',
  accent: '0 0% 18%',
  'accent-foreground': '0 0% 100%',
  destructive: '0 90% 72%',
  'destructive-foreground': '0 0% 0%',
  'destructive-text': '0 90% 72%',
  success: '155 70% 55%',
  'success-foreground': '0 0% 0%',
  'success-text': '155 70% 55%',
  warning: '40 95% 60%',
  'warning-foreground': '0 0% 0%',
  'warning-text': '40 95% 60%',
  info: '190 90% 62%',
  'info-foreground': '0 0% 0%',
  'info-text': '190 90% 62%',
  border: '0 0% 70%',
  input: '0 0% 80%',
  control: '0 0% 80%',
  'on-tone': '0 0% 0%',
  ring: '217 91% 72%',
};

export const UI_THEME_TOKENS: Record<UiTheme, Record<UiMode, UiTokenSet>> = {
  default: { light: DEFAULT_LIGHT, dark: DEFAULT_DARK },
  soft: { light: SOFT_LIGHT, dark: SOFT_DARK },
  'high-contrast': { light: HIGH_CONTRAST_LIGHT, dark: HIGH_CONTRAST_DARK },
};

/** The selector of a theme and mode on the document root. */
export function themeSelector(theme: UiTheme, mode: UiMode): string {
  if (theme === DEFAULT_UI_THEME) return mode === 'dark' ? '.dark' : ':root';
  return mode === 'dark' ? `:root.dark[data-theme='${theme}']` : `:root[data-theme='${theme}']`;
}

function tokenBlock(selector: string, tokens: UiTokenSet): string {
  const lines = [...UI_COLOR_TOKENS, ...UI_SHAPE_TOKENS].map(
    (name) => `    --${name}: ${tokens[name]};`,
  );
  return `  ${selector} {\n${lines.join('\n')}\n  }`;
}

/**
 * The generated `themes.css` of an app. Default keeps the plain `:root` and
 * `.dark` selectors; another theme uses `:root[data-theme]` (light) and
 * `:root.dark[data-theme]` (dark), which outrank `.dark`, so each theme block
 * holds the full token set.
 */
export function renderThemeCss(): string {
  const blocks: string[] = [];
  for (const theme of UI_THEMES) {
    for (const mode of ['light', 'dark'] as const) {
      blocks.push(tokenBlock(themeSelector(theme, mode), UI_THEME_TOKENS[theme][mode]));
    }
  }
  return [
    '/* Generated by `npm run codegen:themes` from @evtivity/lib/ui-theme-tokens. Do not edit. */',
    '@layer base {',
    blocks.join('\n\n'),
    '}',
    '',
  ].join('\n');
}

// WCAG 2.2 contrast ----------------------------------------------------------

function hslToRgb(triplet: string): [number, number, number] {
  const match = /^\s*(-?[\d.]+)\s+([\d.]+)%\s+([\d.]+)%\s*$/.exec(triplet);
  if (match == null) throw new Error(`Not an HSL triplet: ${triplet}`);
  const h = (((Number(match[1]) % 360) + 360) % 360) / 360;
  const s = Number(match[2]) / 100;
  const l = Number(match[3]) / 100;
  if (s === 0) return [l, l, l];
  const q = l < 0.5 ? l * (1 + s) : l + s - l * s;
  const p = 2 * l - q;
  const channel = (t0: number): number => {
    let t = t0;
    if (t < 0) t += 1;
    if (t > 1) t -= 1;
    if (t < 1 / 6) return p + (q - p) * 6 * t;
    if (t < 1 / 2) return q;
    if (t < 2 / 3) return p + (q - p) * (2 / 3 - t) * 6;
    return p;
  };
  return [channel(h + 1 / 3), channel(h), channel(h - 1 / 3)];
}

function luminanceOfRgb(rgb: readonly number[]): number {
  const linear = rgb.map((c) => (c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4));
  return 0.2126 * (linear[0] ?? 0) + 0.7152 * (linear[1] ?? 0) + 0.0722 * (linear[2] ?? 0);
}

function relativeLuminance(triplet: string): number {
  return luminanceOfRgb(hslToRgb(triplet));
}

function ratioOfLuminances(la: number, lb: number): number {
  return (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05);
}

/** WCAG 2.2 contrast ratio of two HSL triplets (1 to 21). */
export function contrastRatio(a: string, b: string): number {
  return ratioOfLuminances(relativeLuminance(a), relativeLuminance(b));
}

/**
 * Contrast of `fg` on a tint: `tone` at `alpha` (0 to 1) over `surface`, as the
 * Alert variants draw it (`bg-warning/10` on the card or the page).
 */
export function contrastOnTint(fg: string, tone: string, surface: string, alpha: number): number {
  const toneRgb = hslToRgb(tone);
  const tint = hslToRgb(surface).map((c, i) => c * (1 - alpha) + (toneRgb[i] ?? 0) * alpha);
  return ratioOfLuminances(relativeLuminance(fg), luminanceOfRgb(tint));
}

export type ContrastKind = 'body' | 'text' | 'boundary';

/**
 * The text and background pairs the apps draw, with what each pair must meet:
 * `body` running text (AA 4.5:1, High Contrast AAA 7:1), `text` other text
 * (labels on fills, links on surfaces: AA 4.5:1), `boundary` form control and
 * focus boundaries (WCAG 1.4.11, 3:1).
 */
export const UI_CONTRAST_PAIRS: readonly {
  fg: UiColorToken;
  bg: UiColorToken;
  kind: ContrastKind;
}[] = [
  { fg: 'foreground', bg: 'background', kind: 'body' },
  { fg: 'card-foreground', bg: 'card', kind: 'body' },
  { fg: 'popover-foreground', bg: 'popover', kind: 'body' },
  { fg: 'muted-foreground', bg: 'background', kind: 'body' },
  { fg: 'muted-foreground', bg: 'card', kind: 'body' },
  { fg: 'secondary-foreground', bg: 'secondary', kind: 'body' },
  { fg: 'accent-foreground', bg: 'accent', kind: 'body' },
  { fg: 'foreground', bg: 'muted', kind: 'body' },
  { fg: 'link', bg: 'card', kind: 'text' },
  { fg: 'link', bg: 'background', kind: 'text' },
  { fg: 'primary-foreground', bg: 'primary', kind: 'text' },
  { fg: 'destructive', bg: 'card', kind: 'text' },
  { fg: 'destructive', bg: 'background', kind: 'text' },
  { fg: 'success', bg: 'card', kind: 'text' },
  { fg: 'success', bg: 'background', kind: 'text' },
  { fg: 'warning-text', bg: 'card', kind: 'text' },
  { fg: 'warning-text', bg: 'background', kind: 'text' },
  { fg: 'info', bg: 'card', kind: 'text' },
  { fg: 'destructive-text', bg: 'card', kind: 'text' },
  { fg: 'destructive-text', bg: 'background', kind: 'text' },
  { fg: 'success-text', bg: 'card', kind: 'text' },
  { fg: 'success-text', bg: 'background', kind: 'text' },
  { fg: 'info-text', bg: 'card', kind: 'text' },
  { fg: 'info-text', bg: 'background', kind: 'text' },
  { fg: 'destructive-foreground', bg: 'destructive', kind: 'text' },
  { fg: 'success-foreground', bg: 'success', kind: 'text' },
  { fg: 'warning-foreground', bg: 'warning', kind: 'text' },
  { fg: 'info-foreground', bg: 'info', kind: 'text' },
  { fg: 'on-tone', bg: 'destructive', kind: 'boundary' },
  { fg: 'on-tone', bg: 'success', kind: 'boundary' },
  { fg: 'on-tone', bg: 'info', kind: 'boundary' },
  { fg: 'input', bg: 'card', kind: 'boundary' },
  { fg: 'input', bg: 'background', kind: 'boundary' },
  { fg: 'control', bg: 'card', kind: 'boundary' },
  { fg: 'ring', bg: 'card', kind: 'boundary' },
  { fg: 'ring', bg: 'background', kind: 'boundary' },
];

/**
 * Text on the 10 percent tone tints of Alert (`bg-<tone>/10` over the card or
 * the page): the tone's text color and muted text must both reach AA 4.5:1.
 */
export const UI_TINT_TEXT_PAIRS: readonly { fg: UiColorToken; tone: UiColorToken }[] = [
  { fg: 'destructive-text', tone: 'destructive' },
  { fg: 'success-text', tone: 'success' },
  { fg: 'info-text', tone: 'info' },
  { fg: 'warning-text', tone: 'warning' },
  { fg: 'muted-foreground', tone: 'destructive' },
  { fg: 'muted-foreground', tone: 'success' },
  { fg: 'muted-foreground', tone: 'info' },
  { fg: 'muted-foreground', tone: 'warning' },
];

/** The alpha of the tone tint behind Alert text. */
export const UI_TINT_ALPHA = 0.1;

/** The ratio a pair must reach in a theme. */
export function requiredContrast(theme: UiTheme, kind: ContrastKind): number {
  if (kind === 'boundary') return 3;
  if (kind === 'body' && theme === 'high-contrast') return 7;
  return 4.5;
}
