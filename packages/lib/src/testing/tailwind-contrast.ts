// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

/**
 * WCAG 2.2 contrast of Tailwind palette classes (`bg-green-500 text-green-950`),
 * read from the Tailwind `theme.css` text the caller passes (its colors are
 * OKLCH). Used by the status badge contrast tests of the CSMS and the portal.
 */

type Rgb = [number, number, number];

function paletteColor(themeCss: string, name: string): Rgb {
  const match = new RegExp(`--color-${name}: oklch\\(([\\d.]+)% ([\\d.]+) ([\\d.]+)\\)`).exec(
    themeCss,
  );
  if (match == null) throw new Error(`No Tailwind color ${name}`);
  const lightness = Number(match[1]) / 100;
  const chroma = Number(match[2]);
  const hue = (Number(match[3]) * Math.PI) / 180;
  const a = chroma * Math.cos(hue);
  const b = chroma * Math.sin(hue);
  const l = (lightness + 0.3963377774 * a + 0.2158037573 * b) ** 3;
  const m = (lightness - 0.1055613458 * a - 0.0638541728 * b) ** 3;
  const s = (lightness - 0.0894841775 * a - 1.291485548 * b) ** 3;
  // Linear sRGB, clipped to the gamut as the browser does.
  const clip = (v: number): number => Math.min(1, Math.max(0, v));
  return [
    clip(4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s),
    clip(-1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s),
    clip(-0.0041960863 * l - 0.7034186147 * m + 1.707614701 * s),
  ];
}

function luminance([r, g, b]: Rgb): number {
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

/** Contrast of the `text-*` color on the `bg-*` color of a class list. */
export function tailwindClassContrast(themeCss: string, className: string): number {
  const bg = /(?:^|\s)bg-([a-z]+-\d+)(?:\s|$)/.exec(className)?.[1];
  const fg = /(?:^|\s)text-([a-z]+-\d+)(?:\s|$)/.exec(className)?.[1];
  if (bg == null || fg == null) throw new Error(`No palette bg and text in "${className}"`);
  const x = luminance(paletteColor(themeCss, bg));
  const y = luminance(paletteColor(themeCss, fg));
  return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05);
}
