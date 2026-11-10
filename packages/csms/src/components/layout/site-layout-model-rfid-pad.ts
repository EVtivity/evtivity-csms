// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

// The RFID card reader pad every charger carries (owner decision
// 2026-11-09): the tap area of the charger's own 13.56 MHz reader (ISO/IEC
// 14443 and ISO/IEC 15693 cards), as on the ABB Terra 94/124/184 ("Plate
// over the RFID reader", installation manual 2.4.2), the ChargePoint CPF50
// ("RFID: ISO 15693 and ISO 14443", data sheet) and the Kempower S-Series
// satellite ("RFID reader (ISO14443A)", data sheet Rev 2.2). A generic pad:
// a raised bezel round a dark window, and on the window a card with radio
// waves above the words "Tap RFID card" in the viewer's language. The
// EMVCo contactless symbol is for payment acceptance only and is never used
// for RFID ("The Contactless Marks should not be used in association with
// 'RFID' products", EMVCo Contactless Marks Acceptable Use Case Guidelines,
// February 2025), so it stays on the payment terminal readers.
//
// Frame: the mounting face is z = 0, the pad stands out along +z, centered
// on the frame origin.

import { ModelParts, frontProfileG } from './site-layout-model-kit';
import type { ModelKit, Pt } from './site-layout-model-kit';

/** The material slots of the pad: its bezel and its dark window. */
export const RFID_PAD_SLOTS = ['bezel', 'window'] as const;
export type RfidPadSlot = (typeof RFID_PAD_SLOTS)[number];

/**
 * The pad's sizes, derived: a 100 mm square window holds an ID-1 card (85.60
 * by 53.98 mm, ISO/IEC 7810) laid on it, a 6 mm bezel round it, 12 mm proud
 * of the face in all. No maker publishes the size of its reader area
 * (research 2026-11-10). A wall box has no pad: its status ring is the reader
 * (`wallBoxRingReaders`).
 */
export const RFID_PAD = {
  windowM: 0.1,
  bezelM: 0.006,
  depthM: 0.012,
  /** The label on the window: a share of the window, just in front of it. */
  labelShare: 0.92,
} as const;

/** The highest a pad's center may stand: its top at 48 in (1.22 m), the high reach of the 2010 ADA Standards 308.2.1 and 308.3.1. */
export const RFID_PAD_MAX_CENTER_M = 1.2192 - (RFID_PAD.windowM / 2 + RFID_PAD.bezelM);

/** The lowest a pad's center may stand: its bottom at 15 in (0.38 m), the low reach of 308.2.1. */
export const RFID_PAD_MIN_CENTER_M = 0.381 + RFID_PAD.windowM / 2 + RFID_PAD.bezelM;

function rounded(w: number, h: number, r: number, n = 4): Pt[] {
  const pts: Pt[] = [];
  const corners: Array<[number, number, number]> = [
    [w / 2 - r, h / 2 - r, 0],
    [-w / 2 + r, h / 2 - r, Math.PI / 2],
    [-w / 2 + r, -h / 2 + r, Math.PI],
    [w / 2 - r, -h / 2 + r, (3 * Math.PI) / 2],
  ];
  for (const [cx, cy, a0] of corners) {
    for (let i = 0; i <= n; i += 1) {
      const a = a0 + ((Math.PI / 2) * i) / n;
      pts.push([cx + r * Math.cos(a), cy + r * Math.sin(a)]);
    }
  }
  return pts;
}

/** The pad of window `windowM` (a bezel with a chamfered edge round a recessed window). */
export function createRfidPadKit(windowM: number = RFID_PAD.windowM): ModelKit<RfidPadSlot> {
  const p = new ModelParts<RfidPadSlot>();
  const outer = windowM + 2 * RFID_PAD.bezelM;
  // The bezel: a rounded square frame with a softened edge round the window opening.
  const opening = [...rounded(windowM, windowM, 0.008)].reverse();
  p.add('bezel', frontProfileG(rounded(outer, outer, 0.012), RFID_PAD.depthM, 0.002, [opening]), {
    at: [0, 0, RFID_PAD.depthM / 2],
  });
  // The window, recessed in the opening (its face `RFID_WINDOW_RECESS_M` behind the bezel's).
  p.add('window', frontProfileG(rounded(windowM, windowM, 0.008), RFID_PAD.depthM - 0.002), {
    at: [0, 0, (RFID_PAD.depthM - 0.002) / 2],
  });
  return p.kit();
}

/** How far the window's face stands behind the bezel's. */
export const RFID_WINDOW_RECESS_M = 0.002;

/** Where the label plane stands in the pad frame: just in front of the recessed window. */
export function rfidLabelZ(): number {
  return RFID_PAD.depthM - RFID_WINDOW_RECESS_M + 0.0004;
}

/** The canvas size the label is drawn at (square, px). */
export const RFID_LABEL_PX = 256;

/** What the label drawing needs of a canvas 2D context. */
export interface LabelContext {
  fillStyle: string | CanvasGradient | CanvasPattern;
  strokeStyle: string | CanvasGradient | CanvasPattern;
  lineWidth: number;
  lineCap: CanvasLineCap;
  font: string;
  textAlign: CanvasTextAlign;
  textBaseline: CanvasTextBaseline;
  fillRect: (x: number, y: number, w: number, h: number) => void;
  beginPath: () => void;
  moveTo: (x: number, y: number) => void;
  lineTo: (x: number, y: number) => void;
  arc: (x: number, y: number, r: number, a0: number, a1: number) => void;
  arcTo: (x1: number, y1: number, x2: number, y2: number, r: number) => void;
  closePath: () => void;
  stroke: () => void;
  fill: () => void;
  fillText: (text: string, x: number, y: number, maxWidth?: number) => void;
  measureText: (text: string) => { width: number };
}

/** The words of the label split into at most two lines that fit `maxPx` at `fontPx`. */
export function rfidLabelLines(
  text: string,
  measure: (s: string) => number,
  maxPx: number,
): string[] {
  const words = text
    .trim()
    .split(/\s+/)
    .filter((w) => w !== '');
  if (words.length === 0) return [];
  if (measure(words.join(' ')) <= maxPx || words.length === 1) return [words.join(' ')];
  // The split that keeps the longer line shortest.
  let best: string[] = [words.join(' ')];
  let bestW = Infinity;
  for (let i = 1; i < words.length; i += 1) {
    const a = words.slice(0, i).join(' ');
    const b = words.slice(i).join(' ');
    const w = Math.max(measure(a), measure(b));
    if (w < bestW) {
      bestW = w;
      best = [a, b];
    }
  }
  return best;
}

/**
 * The tap pictogram: a card of ID-1 proportions (85.60 by 53.98) `cw` px wide
 * centered on (`cx`, `cy`), tilted as a hand holds it, three radio wave arcs
 * rising from its top right corner; `s` the canvas size the strokes scale with.
 */
function drawTapCard(ctx: LabelContext, s: number, cx: number, cy: number, cw: number): void {
  const ch = (cw * 53.98) / 85.6;
  ctx.lineWidth = s * 0.03;
  const r = s * 0.03;
  const x0 = cx - cw / 2;
  const y0 = cy - ch / 2;
  ctx.beginPath();
  ctx.moveTo(x0 + r, y0);
  ctx.arcTo(x0 + cw, y0, x0 + cw, y0 + ch, r);
  ctx.arcTo(x0 + cw, y0 + ch, x0, y0 + ch, r);
  ctx.arcTo(x0, y0 + ch, x0, y0, r);
  ctx.arcTo(x0, y0, x0 + cw, y0, r);
  ctx.closePath();
  ctx.stroke();
  ctx.fillRect(x0 + cw * 0.14, y0 + ch * 0.32, cw * 0.2, ch * 0.26);
  ctx.fillRect(x0 + cw * 0.14, y0 + ch * 0.72, cw * 0.55, s * 0.012);
  // Three waves rising from the card's top right corner.
  ctx.lineWidth = s * 0.026;
  const step = (cw / (s * 0.38)) * s * 0.055;
  for (const k of [1, 2, 3]) {
    ctx.beginPath();
    ctx.arc(x0 + cw * 0.86, y0, step * k, -Math.PI * 0.45, -Math.PI * 0.05);
    ctx.stroke();
  }
}

/** The light ink of the tap label and the dark window it stands on. */
const LABEL_INK = '#f3f4f6';
const LABEL_WINDOW = '#1f2937';

/**
 * Draws the tap label on a `RFID_LABEL_PX` square: a card (ID-1 proportions,
 * 85.60 by 53.98) tilted as a hand holds it, three radio wave arcs above it,
 * and `text` below in up to two lines, light on the dark window.
 */
export function drawRfidLabel(ctx: LabelContext, text: string, fontFamily: string): void {
  const s = RFID_LABEL_PX;
  ctx.fillStyle = LABEL_WINDOW;
  ctx.fillRect(0, 0, s, s);
  ctx.strokeStyle = LABEL_INK;
  ctx.fillStyle = LABEL_INK;
  ctx.lineCap = 'round';
  drawTapCard(ctx, s, s * 0.42, s * 0.36, s * 0.38);
  // The words, as large as fit two lines across the window.
  const fontPx = Math.round(s * 0.15);
  ctx.font = `600 ${String(fontPx)}px ${fontFamily}`;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  const lines = rfidLabelLines(text, (t) => ctx.measureText(t).width, s * 0.9);
  const top = lines.length > 1 ? s * 0.68 : s * 0.76;
  lines.forEach((line, i) => {
    ctx.fillText(line, s / 2, top + i * fontPx * 1.1, s * 0.92);
  });
}

/**
 * The tap pictogram alone, for a reader inside a lit status ring (a wall
 * box, `wallBoxRingReaders`): the card and its waves, light on the dark
 * window, centered on a `RFID_LABEL_PX` square the scene crops to a disc.
 */
export function drawRfidPictogram(ctx: LabelContext): void {
  const s = RFID_LABEL_PX;
  ctx.fillStyle = LABEL_WINDOW;
  ctx.fillRect(0, 0, s, s);
  ctx.strokeStyle = LABEL_INK;
  ctx.fillStyle = LABEL_INK;
  ctx.lineCap = 'round';
  drawTapCard(ctx, s, s * 0.45, s * 0.58, s * 0.5);
}

/** The canvas the one-line caption of a ring reader is drawn at (px). */
export const RFID_CAPTION_PX = { width: 512, height: 96 } as const;

/**
 * Draws `text` (the tap line) on one line of a `RFID_CAPTION_PX` strip:
 * light letters on a dark rounded strip, so the line reads on any plate
 * color, the font shrunk until the line fits.
 */
export function drawRfidCaption(ctx: LabelContext, text: string, fontFamily: string): void {
  const { width: w, height: h } = RFID_CAPTION_PX;
  const r = h * 0.3;
  ctx.fillStyle = LABEL_WINDOW;
  ctx.beginPath();
  ctx.moveTo(r, 0);
  ctx.arcTo(w, 0, w, h, r);
  ctx.arcTo(w, h, 0, h, r);
  ctx.arcTo(0, h, 0, 0, r);
  ctx.arcTo(0, 0, w, 0, r);
  ctx.closePath();
  ctx.fill();
  ctx.fillStyle = LABEL_INK;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  const line = text.trim().split(/\s+/).join(' ');
  let fontPx = Math.round(h * 0.62);
  ctx.font = `600 ${String(fontPx)}px ${fontFamily}`;
  while (fontPx > 12 && ctx.measureText(line).width > w * 0.9) {
    fontPx -= 2;
    ctx.font = `600 ${String(fontPx)}px ${fontFamily}`;
  }
  ctx.fillText(line, w / 2, h / 2, w * 0.92);
}
