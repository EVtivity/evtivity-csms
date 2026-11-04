// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { describe, expect, it } from 'vitest';
import { SCREEN_MESSAGE } from '../site-layout-grid';
import {
  canvasScreenTextMeasure,
  fitScreenMessage,
  fitScreenText,
  SCREEN_TEXT_LINE_HEIGHT,
  SCREEN_TEXT_MAX_CHARS,
  screenPlainText,
  screenTextBox,
  screenTextFont,
  wrapScreenText,
  parseScreenHoverKey,
  SCREEN_SCROLL_FONTS_PER_S,
  SCREEN_SCROLL_MAX_CANVAS_PX,
  SCREEN_SCROLL_SEPARATOR,
  SCREEN_TEXT_READABLE_M,
  screenHoverKey,
  screenOneLineFontPx,
  screenReadableFontPx,
  screenTextPlan,
  type ScreenKind,
  type ScreenTextBox,
} from '../site-layout-screen-text';

// Every character is half the font size wide.
const measure = (text: string, fontPx: number): number => Array.from(text).length * fontPx * 0.5;

const box: ScreenTextBox = { width: 200, height: 100, minFontPx: 10, maxFontPx: 40 };

function fitsBox(lines: readonly string[], fontPx: number, b: ScreenTextBox): boolean {
  return (
    lines.every((l) => measure(l, fontPx) <= b.width) &&
    lines.length * fontPx * SCREEN_TEXT_LINE_HEIGHT <= b.height
  );
}

describe('screenPlainText', () => {
  it('drops tags, keeps template line breaks and collapses spaces', () => {
    expect(screenPlainText('<b>Acme</b>&nbsp; Charging\n\n  CS-1  \nPlug in<br/>to start')).toBe(
      'Acme Charging\nCS-1\nPlug in\nto start',
    );
  });

  it('cuts long text with an ellipsis', () => {
    const text = screenPlainText('x'.repeat(400));
    expect(Array.from(text)).toHaveLength(SCREEN_TEXT_MAX_CHARS);
    expect(text.endsWith('…')).toBe(true);
  });
});

describe('wrapScreenText', () => {
  it('wraps by words and keeps paragraph breaks', () => {
    expect(wrapScreenText('aaa bbb ccc\nddd', 50, 10, measure)).toEqual(['aaa bbb', 'ccc', 'ddd']);
  });

  it('breaks a word or a CJK run wider than the screen between characters', () => {
    expect(wrapScreenText('欢迎使用充电桩服务', 40, 10, measure)).toEqual([
      '欢迎使用充电桩服',
      '务',
    ]);
  });
});

describe('fitScreenText', () => {
  it('uses the largest size for a short text', () => {
    const fit = fitScreenText('Hi', box, measure);
    expect(fit.fontPx).toBe(40);
    expect(fit.lines).toEqual(['Hi']);
    expect(fit.truncated).toBe(false);
    expect(fit.lineHeightPx).toBeCloseTo(40 * SCREEN_TEXT_LINE_HEIGHT);
  });

  it('shrinks a longer text to the largest size that fits, with wrapping', () => {
    const fit = fitScreenText('Welcome to Acme Charging', box, measure);
    expect(fit.truncated).toBe(false);
    expect(fitsBox(fit.lines, fit.fontPx, box)).toBe(true);
    expect(fit.lines.join(' ')).toBe('Welcome to Acme Charging');
    // One pixel larger no longer fits.
    const larger = wrapScreenText('Welcome to Acme Charging', box.width, fit.fontPx + 1, measure);
    expect(fitsBox(larger, fit.fontPx + 1, box)).toBe(false);
  });

  it('never goes below the minimum size and ends text that does not fit with an ellipsis', () => {
    const fit = fitScreenText('word '.repeat(200), box, measure);
    expect(fit.fontPx).toBe(box.minFontPx);
    expect(fit.truncated).toBe(true);
    expect(fit.lines.at(-1)?.endsWith('…')).toBe(true);
    expect(fitsBox(fit.lines, fit.fontPx, box)).toBe(true);
  });

  it('returns no lines for empty text', () => {
    expect(fitScreenText('  ', box, measure)).toMatchObject({ lines: [], truncated: false });
  });
});

describe('screenTextBox and fitScreenMessage', () => {
  it('gives every charger model a font range inside its screen', () => {
    for (const kind of Object.keys(SCREEN_MESSAGE) as ScreenKind[]) {
      const b = screenTextBox(kind);
      const spec = SCREEN_MESSAGE[kind];
      expect(b.width).toBeLessThan(spec.canvas.width);
      expect(b.height).toBeLessThan(spec.canvas.height);
      expect(b.minFontPx).toBeLessThan(b.maxFontPx);
      // Two lines at the largest size fit the screen.
      expect(2 * b.maxFontPx * SCREEN_TEXT_LINE_HEIGHT).toBeLessThanOrEqual(b.height);
    }
  });

  it('fits a five-line template text on each screen with its line breaks', () => {
    for (const kind of Object.keys(SCREEN_MESSAGE) as ScreenKind[]) {
      const fit = fitScreenMessage(
        'Acme\nCS-1\n$0.30/kWh\nincl. 19% tax\nPlug in to start',
        kind,
        measure,
      );
      expect(fit.truncated).toBe(false);
      expect(fit.lines.slice(0, 2)).toEqual(['Acme', 'CS-1']);
      expect(fitsBox(fit.lines, fit.fontPx, screenTextBox(kind))).toBe(true);
    }
  });
});

describe('canvasScreenTextMeasure', () => {
  it('sets the screen font before measuring', () => {
    const fonts: string[] = [];
    const ctx = {
      font: '',
      measureText(text: string) {
        fonts.push(this.font);
        return { width: text.length };
      },
    };
    expect(canvasScreenTextMeasure(ctx)('abc', 24)).toBe(3);
    expect(fonts).toEqual([screenTextFont(24)]);
    expect(screenTextFont(24)).toMatch(/^600 24px /);
  });
});

describe('screenTextPlan', () => {
  const kinds = Object.keys(SCREEN_MESSAGE) as ScreenKind[];

  it('keeps every screen font at the readable size or one full-height line', () => {
    expect(SCREEN_TEXT_READABLE_M).toBeGreaterThan(0.025);
    expect(SCREEN_TEXT_READABLE_M).toBeLessThan(0.027);
    for (const kind of kinds) {
      const floor = Math.min(screenReadableFontPx(kind), screenOneLineFontPx(kind));
      for (const text of ['Welcome to Acme', 'Plug in', 'word '.repeat(60)]) {
        const plan = screenTextPlan(text, kind, measure, { reducedMotion: false });
        const fontPx = plan.mode === 'static' ? plan.fit.fontPx : plan.fontPx;
        expect(fontPx).toBeGreaterThanOrEqual(floor);
        // Moving text is never cut.
        if (plan.mode === 'static') expect(plan.fit.truncated).toBe(false);
      }
    }
    // The wall box display is too small for a readable line of this text: it scrolls.
    expect(
      screenTextPlan('Welcome to Acme', 'wallbox', measure, { reducedMotion: false }).mode,
    ).toBe('scroll');
    expect(screenTextPlan('Welcome to Acme', 'dc', measure, { reducedMotion: false }).mode).toBe(
      'static',
    );
  });

  it('wraps a text that fits and scrolls a long one as one line', () => {
    const long = 'Idle fees of 0.40 per minute apply 15 minutes after charging ends.';
    const short = screenTextPlan('Plug in\nto start', 'dc', measure, { reducedMotion: false });
    expect(short.mode).toBe('static');
    const plan = screenTextPlan(`Acme\n${long}`, 'ac57in', measure, { reducedMotion: false });
    if (plan.mode !== 'scroll') throw new Error('expected a scrolling line');
    expect(plan.text.startsWith(`Acme${SCREEN_SCROLL_SEPARATOR}Idle fees`)).toBe(true);
    expect(plan.text).not.toContain('\n');
    expect(plan.fontPx).toBeGreaterThanOrEqual(screenReadableFontPx('ac57in'));
    expect(plan.fontPx).toBeLessThanOrEqual(screenOneLineFontPx('ac57in'));
    // The line plus one screen width of gap, so it comes round again.
    expect(plan.canvasWidthPx).toBe(
      Math.ceil(measure(plan.text, plan.fontPx)) + SCREEN_MESSAGE.ac57in.canvas.width,
    );
    expect(plan.speed).toBeCloseTo((SCREEN_SCROLL_FONTS_PER_S * plan.fontPx) / plan.canvasWidthPx);
    expect(plan.scale).toBe(1);
  });

  it('draws a line too wide for one texture on a smaller canvas', () => {
    const plan = screenTextPlan('x'.repeat(300), 'dc', measure, { reducedMotion: false });
    if (plan.mode !== 'scroll') throw new Error('expected a scrolling line');
    expect(plan.canvasWidthPx * plan.scale).toBeLessThanOrEqual(SCREEN_SCROLL_MAX_CANVAS_PX);
    expect(plan.scale).toBeLessThan(1);
  });

  it('stands still under reduced motion: wrapped and cut with an ellipsis', () => {
    const plan = screenTextPlan('word '.repeat(80), 'wallbox', measure, { reducedMotion: true });
    if (plan.mode !== 'static') throw new Error('expected a static screen');
    expect(plan.fit.truncated).toBe(true);
    expect(plan.fit.lines.at(-1)?.endsWith('…')).toBe(true);
  });

  it('draws nothing for empty text', () => {
    const plan = screenTextPlan('<b></b>', 'ac', measure, { reducedMotion: false });
    if (plan.mode !== 'static') throw new Error('expected a static screen');
    expect(plan.fit.lines).toEqual([]);
  });
});

describe('screen hover keys', () => {
  it('names the screen model and the station and reads them back', () => {
    const key = screenHoverKey('reader', 'sta:1');
    expect(key).toBe('screen:reader:sta:1');
    expect(parseScreenHoverKey(key)).toEqual({ kind: 'reader', stationId: 'sta:1' });
  });

  it('reads no other equipment key', () => {
    expect(parseScreenHoverKey(null)).toBeNull();
    expect(parseScreenHoverKey('virtual:sta_1')).toBeNull();
    expect(parseScreenHoverKey('screen:toaster:sta_1')).toBeNull();
    expect(parseScreenHoverKey('screen:dc:')).toBeNull();
    expect(parseScreenHoverKey('screen:constructor:sta_1')).toBeNull();
  });
});
