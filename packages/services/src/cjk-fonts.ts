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
