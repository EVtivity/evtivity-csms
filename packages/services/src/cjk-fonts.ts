// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { readFileSync } from 'node:fs';
import { createLogger } from '@evtivity/lib';
import { CJK_FONT_FACES, CJK_FONT_FILES } from './pdf-fonts.js';

const logger = createLogger('pdf-fonts');

export interface PdfFonts {
  regular: string;
  bold: string;
}

/** Latin languages use the standard Helvetica fonts built into pdfkit. */
export const LATIN_FONTS: PdfFonts = { regular: 'Helvetica', bold: 'Helvetica-Bold' };

export type CjkLanguage = keyof typeof CJK_FONT_FACES;

export function isCjkLanguage(language: string): language is CjkLanguage {
  return Object.hasOwn(CJK_FONT_FACES, language);
}

interface CjkFontData {
  regular: Buffer;
  bold: Buffer;
}

/** undefined: not read yet. null: a file is missing (warned once). */
let cjkFontData: CjkFontData | null | undefined;

/**
 * The CJK font collections, read once per process. Returns null and logs one
 * warn when a file is missing (local dev outside the API and worker images).
 */
function loadCjkFonts(): CjkFontData | null {
  if (cjkFontData !== undefined) return cjkFontData;
  try {
    cjkFontData = {
      regular: readFileSync(CJK_FONT_FILES.regular),
      bold: readFileSync(CJK_FONT_FILES.bold),
    };
  } catch (err) {
    logger.warn(
      { err, files: CJK_FONT_FILES },
      'CJK fonts not found, Korean and Chinese PDFs render in English',
    );
    cjkFontData = null;
  }
  return cjkFontData;
}

/** True when a PDF can render the language: Latin always, CJK with the fonts. */
export function pdfCanRender(language: string): boolean {
  return !isCjkLanguage(language) || loadCjkFonts() != null;
}

/**
 * Registers the fonts of the language on the document and returns their
 * names. A Latin language, or a CJK language without the fonts, gets Helvetica.
 */
export function registerPdfFonts(doc: PDFKit.PDFDocument, language: string): PdfFonts {
  if (!isCjkLanguage(language)) return LATIN_FONTS;
  const data = loadCjkFonts();
  if (data == null) return LATIN_FONTS;
  const faces = CJK_FONT_FACES[language];
  doc.registerFont('Cjk', data.regular, faces.regular);
  doc.registerFont('Cjk-Bold', data.bold, faces.bold);
  return { regular: 'Cjk', bold: 'Cjk-Bold' };
}

// Characters Helvetica draws (WinAnsi): Latin-1 plus the typographic marks of
// Windows-1252 that a footer is likely to hold.
const WIN_ANSI_TEXT =
  /^[\n\u0020-\u007E\u00A0-\u00FF\u20AC\u2013\u2014\u2018\u2019\u201C\u201D\u2022\u2026]*$/;

/**
 * Registers the font of a PDF footer and returns its name. The choice
 * depends on the text only, so the footer looks the same in every PDF:
 * Helvetica when it can draw every character, else the Simplified Chinese
 * Noto Sans CJK face (which also covers Latin, Hangul, kana and Han), and
 * Helvetica again when the CJK fonts are missing.
 */
export function registerPdfFooterFont(doc: PDFKit.PDFDocument, text: string): string {
  if (WIN_ANSI_TEXT.test(text)) return LATIN_FONTS.regular;
  const data = loadCjkFonts();
  if (data == null) return LATIN_FONTS.regular;
  doc.registerFont('Cjk-Footer', data.regular, CJK_FONT_FACES.zh.regular);
  return 'Cjk-Footer';
}

/**
 * The fonts for operator text (such as the invoice seller block) drawn in a
 * document that uses `fonts`. A CJK document font covers it; a Latin one
 * covers WinAnsi text only, so other text gets the Simplified Chinese Noto
 * Sans CJK face (Latin, Hangul, kana and Han), or Helvetica without the CJK
 * fonts.
 */
export function registerPdfTextFonts(
  doc: PDFKit.PDFDocument,
  fonts: PdfFonts,
  text: string,
): PdfFonts {
  if (fonts !== LATIN_FONTS || WIN_ANSI_TEXT.test(text)) return fonts;
  const data = loadCjkFonts();
  if (data == null) return fonts;
  doc.registerFont('Cjk-Text', data.regular, CJK_FONT_FACES.zh.regular);
  doc.registerFont('Cjk-Text-Bold', data.bold, CJK_FONT_FACES.zh.bold);
  return { regular: 'Cjk-Text', bold: 'Cjk-Text-Bold' };
}
