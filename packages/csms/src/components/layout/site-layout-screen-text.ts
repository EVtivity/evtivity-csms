// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

// How the text of a charger screen fits its screen: as large as the screen
// of that charger model allows, wrapped by words (by characters for a word
// or a CJK run wider than the screen), never below a minimum size, and cut
// with an ellipsis when it still does not fit. No three.js, no DOM: the
// caller passes a measure function (a canvas 2D context in the scene).

import { CAMERA_FOV, MIN_DISTANCE, SCREEN_MESSAGE } from './site-layout-grid.js';

/** Where the screen text of the layout reply comes from (`screenMessage.source`). */
export type ScreenMessageSource =
  | 'display_message'
  | 'station_message_template'
  | 'default_welcome';

/** The `screenMessage` of a layout station. */
export interface ScreenMessage {
  text: string;
  source: ScreenMessageSource;
}

export type ScreenKind = keyof typeof SCREEN_MESSAGE;

/** The most characters a screen shows; longer text ends with an ellipsis. */
export const SCREEN_TEXT_MAX_CHARS = 300;
/** Line height as a multiple of the font size. */
export const SCREEN_TEXT_LINE_HEIGHT = 1.18;
/** Share of the canvas width and height the text may use (the rest is margin). */
export const SCREEN_TEXT_AREA = 0.9;
/** The font of every charger screen (the scene and the zoom overlay). */
export const SCREEN_TEXT_FONT_FAMILY = 'system-ui, -apple-system, "Segoe UI", sans-serif';
export const SCREEN_TEXT_FONT_WEIGHT = 600;

const ELLIPSIS = '…';

/**
 * Screen text as plain lines: tags dropped, `&nbsp;` as a space, spaces
 * collapsed within a line, the line breaks of a template kept, empty lines
 * dropped, at most `SCREEN_TEXT_MAX_CHARS` characters.
 */
export function screenPlainText(content: string): string {
  const lines = content
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<[^>]*>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .split(/\r?\n/)
    .map((line) => line.replace(/\s+/g, ' ').trim())
    .filter((line) => line !== '');
  const plain = lines.join('\n');
  const chars = Array.from(plain);
  return chars.length > SCREEN_TEXT_MAX_CHARS
    ? `${chars.slice(0, SCREEN_TEXT_MAX_CHARS - 1).join('')}${ELLIPSIS}`
    : plain;
}

/** The width of `text` drawn at `fontPx` (canvas pixels). */
export type ScreenTextMeasure = (text: string, fontPx: number) => number;

/** The text area of a screen in canvas pixels and the font sizes it allows. */
export interface ScreenTextBox {
  width: number;
  height: number;
  minFontPx: number;
  maxFontPx: number;
}

/**
 * The smallest font as a share of the screen height: a ninth, so a screen
 * holds about seven lines (a five-line station message template fits every
 * charger model) before the text is cut.
 */
export const SCREEN_TEXT_MIN_FONT_SHARE = 1 / 9;

/**
 * The text area of a charger model's screen (`SCREEN_MESSAGE`): the font is
 * at most a little under half the screen height (two lines fill it) and at
 * least `SCREEN_TEXT_MIN_FONT_SHARE` of it.
 */
export function screenTextBox(kind: ScreenKind): ScreenTextBox {
  const { width, height } = SCREEN_MESSAGE[kind].canvas;
  return {
    width: Math.floor(width * SCREEN_TEXT_AREA),
    height: Math.floor(height * SCREEN_TEXT_AREA),
    minFontPx: Math.max(8, Math.round(height * SCREEN_TEXT_MIN_FONT_SHARE)),
    maxFontPx: Math.round(height / (2 * SCREEN_TEXT_LINE_HEIGHT + 0.3)),
  };
}

export interface ScreenTextFit {
  fontPx: number;
  lineHeightPx: number;
  lines: string[];
  /** True when the text did not fit at the minimum size and ends with an ellipsis. */
  truncated: boolean;
}

function wrapParagraph(paragraph: string, width: number, measure: (s: string) => number): string[] {
  const lines: string[] = [];
  let line = '';
  for (const word of paragraph.split(' ').filter((w) => w !== '')) {
    const joined = line === '' ? word : `${line} ${word}`;
    if (measure(joined) <= width) {
      line = joined;
      continue;
    }
    if (line !== '') lines.push(line);
    line = '';
    if (measure(word) <= width) {
      line = word;
      continue;
    }
    // A word (or a CJK run) wider than the screen breaks between characters.
    for (const ch of Array.from(word)) {
      const next = line + ch;
      if (line === '' || measure(next) <= width) {
        line = next;
      } else {
        lines.push(line);
        line = ch;
      }
    }
  }
  if (line !== '') lines.push(line);
  return lines;
}

/** Every line of `text` wrapped to `width` at `fontPx`. */
export function wrapScreenText(
  text: string,
  width: number,
  fontPx: number,
  measure: ScreenTextMeasure,
): string[] {
  const m = (s: string): number => measure(s, fontPx);
  return text.split('\n').flatMap((paragraph) => wrapParagraph(paragraph, width, m));
}

function fits(lines: readonly string[], fontPx: number, box: ScreenTextBox): boolean {
  return lines.length * fontPx * SCREEN_TEXT_LINE_HEIGHT <= box.height;
}

/**
 * The largest font from `box.maxFontPx` down to `box.minFontPx` at which the
 * wrapped text fits the box. When none does, the text at the minimum size,
 * cut to the lines that fit with an ellipsis on the last one.
 */
export function fitScreenText(
  text: string,
  box: ScreenTextBox,
  measure: ScreenTextMeasure,
): ScreenTextFit {
  const result = (fontPx: number, lines: string[], truncated: boolean): ScreenTextFit => ({
    fontPx,
    lineHeightPx: fontPx * SCREEN_TEXT_LINE_HEIGHT,
    lines,
    truncated,
  });
  const plain = text.trim();
  if (plain === '') return result(box.maxFontPx, [], false);

  // Fewer lines at a smaller size, so the largest size that fits is found by halving.
  let lo = box.minFontPx;
  let hi = Math.max(box.minFontPx, box.maxFontPx);
  let best: { fontPx: number; lines: string[] } | null = null;
  while (lo <= hi) {
    const mid = Math.floor((lo + hi) / 2);
    const lines = wrapScreenText(plain, box.width, mid, measure);
    if (fits(lines, mid, box)) {
      best = { fontPx: mid, lines };
      lo = mid + 1;
    } else {
      hi = mid - 1;
    }
  }
  if (best != null) return result(best.fontPx, best.lines, false);

  const fontPx = box.minFontPx;
  const all = wrapScreenText(plain, box.width, fontPx, measure);
  const maxLines = Math.max(1, Math.floor(box.height / (fontPx * SCREEN_TEXT_LINE_HEIGHT)));
  const kept = all.slice(0, maxLines);
  const last = Array.from(kept[kept.length - 1] ?? '');
  while (last.length > 0 && measure(`${last.join('')}${ELLIPSIS}`, fontPx) > box.width) {
    last.pop();
  }
  kept[kept.length - 1] = `${last.join('').trimEnd()}${ELLIPSIS}`;
  return result(fontPx, kept, true);
}

/** `fitScreenText` for the screen of a charger model. */
export function fitScreenMessage(
  text: string,
  kind: ScreenKind,
  measure: ScreenTextMeasure,
): ScreenTextFit {
  return fitScreenText(screenPlainText(text), screenTextBox(kind), measure);
}

/** The CSS font of the screen text at a size, for a canvas 2D context. */
export function screenTextFont(fontPx: number): string {
  return `${String(SCREEN_TEXT_FONT_WEIGHT)} ${String(fontPx)}px ${SCREEN_TEXT_FONT_FAMILY}`;
}

/** A measure function over a canvas 2D context (sets its font for each call). */
export function canvasScreenTextMeasure(ctx: {
  font: string;
  measureText: (text: string) => { width: number };
}): ScreenTextMeasure {
  return (text, fontPx) => {
    ctx.font = screenTextFont(fontPx);
    return ctx.measureText(text).width;
  };
}

/**
 * The smallest text a charger screen draws in the scene, in meters of font
 * size, so it is readable at the nearest zoom. Derived: at `MIN_DISTANCE`
 * (3 m) the `CAMERA_FOV` (35 degrees) frame is 2 x 3 x tan(17.5 deg) = 1.89 m
 * tall, which a 720 px tall view draws at 381 px per meter; a 10 px font
 * (about 7 px capital height, the smallest comfortable label size) is then
 * 10 / 381 = 0.026 m. A screen too small for one line of that size draws its
 * largest one line.
 */
export const SCREEN_TEXT_READABLE_M =
  10 / (720 / (2 * MIN_DISTANCE * Math.tan(((CAMERA_FOV / 2) * Math.PI) / 180)));

/**
 * How fast long text scrolls, in font sizes per second: about 7 characters a
 * second at the average character width of about 0.55 font sizes, the pace
 * of a moving message sign.
 */
export const SCREEN_SCROLL_FONTS_PER_S = 4;
/** The widest canvas a scrolling line is drawn on (WebGL textures reach 8192 px everywhere). */
export const SCREEN_SCROLL_MAX_CANVAS_PX = 8192;
/** The separator that joins the lines of a template into one scrolling line. */
export const SCREEN_SCROLL_SEPARATOR = ' · ';

/** The font size of `kind`'s screen that is `SCREEN_TEXT_READABLE_M` tall, in canvas pixels. */
export function screenReadableFontPx(kind: ScreenKind): number {
  const spec = SCREEN_MESSAGE[kind];
  return Math.ceil((SCREEN_TEXT_READABLE_M * spec.canvas.height) / spec.height);
}

/** The largest font one line of text fits the screen's text area at, in canvas pixels. */
export function screenOneLineFontPx(kind: ScreenKind): number {
  return Math.floor(screenTextBox(kind).height / SCREEN_TEXT_LINE_HEIGHT);
}

/**
 * What a charger screen draws in the scene: `static`, the text wrapped at the
 * largest readable font that holds all of it (cut with an ellipsis only under
 * reduced motion); else `scroll`, the text as one line that keeps moving
 * across the screen. `scale` (at most 1) shrinks the canvas of a line too long
 * for `SCREEN_SCROLL_MAX_CANVAS_PX`, the font keeping its share of the screen
 * height. `speed` is in canvas widths per second (the texture offset).
 */
export type ScreenTextPlan =
  | { mode: 'static'; fit: ScreenTextFit }
  | {
      mode: 'scroll';
      text: string;
      fontPx: number;
      /** The line at `fontPx` plus one screen width of gap before it comes round again. */
      canvasWidthPx: number;
      scale: number;
      speed: number;
    };

export function screenTextPlan(
  text: string,
  kind: ScreenKind,
  measure: ScreenTextMeasure,
  options: { reducedMotion: boolean },
): ScreenTextPlan {
  const plain = screenPlainText(text);
  const box = screenTextBox(kind);
  const oneLine = screenOneLineFontPx(kind);
  const minFontPx = Math.min(oneLine, Math.max(box.minFontPx, screenReadableFontPx(kind)));
  const fit = fitScreenText(
    plain,
    { ...box, minFontPx, maxFontPx: Math.max(minFontPx, box.maxFontPx) },
    measure,
  );
  if (!fit.truncated || options.reducedMotion) return { mode: 'static', fit };
  const line = plain.split('\n').join(SCREEN_SCROLL_SEPARATOR);
  // Half the screen height, as a moving sign, never below the readable size.
  const fontPx = Math.min(
    oneLine,
    Math.max(minFontPx, Math.round(SCREEN_MESSAGE[kind].canvas.height * 0.5)),
  );
  const canvasWidthPx = Math.ceil(measure(line, fontPx)) + SCREEN_MESSAGE[kind].canvas.width;
  return {
    mode: 'scroll',
    text: line,
    fontPx,
    canvasWidthPx,
    scale: Math.min(1, SCREEN_SCROLL_MAX_CANVAS_PX / canvasWidthPx),
    speed: (SCREEN_SCROLL_FONTS_PER_S * fontPx) / canvasWidthPx,
  };
}

const SCREEN_HOVER_PREFIX = 'screen:';

/** The hover key of a charger screen (`onEquipmentHover`): `screen:<kind>:<stationId>`. */
export function screenHoverKey(kind: ScreenKind, stationId: string): string {
  return `${SCREEN_HOVER_PREFIX}${kind}:${stationId}`;
}

/** The charger screen a hover key names, or null for any other key. */
export function parseScreenHoverKey(
  key: string | null,
): { kind: ScreenKind; stationId: string } | null {
  if (key?.startsWith(SCREEN_HOVER_PREFIX) !== true) return null;
  const rest = key.slice(SCREEN_HOVER_PREFIX.length);
  const at = rest.indexOf(':');
  if (at <= 0) return null;
  const kind = rest.slice(0, at);
  const stationId = rest.slice(at + 1);
  if (!Object.hasOwn(SCREEN_MESSAGE, kind) || stationId === '') return null;
  return { kind: kind as ScreenKind, stationId };
}
