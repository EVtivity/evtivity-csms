// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

// The PDF font choice (`cjk-fonts.ts`) with and without the CJK font files,
// and the revenue site condition (`session-revenue.ts`).

import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { PgDialect } from 'drizzle-orm/pg-core';
import type { SQL } from 'drizzle-orm';
import { revenueAtSites } from '../session-revenue.js';

// Any readable file stands in for a font collection: the fake document never parses it.
const READABLE = fileURLToPath(import.meta.url);

function fakeDoc() {
  const registered: { name: string; face: string }[] = [];
  const doc = {
    registerFont: vi.fn((name: string, _data: Buffer, face: string) => {
      registered.push({ name, face });
      return doc;
    }),
  };
  return { doc: doc as unknown as PDFKit.PDFDocument, registered };
}

async function loadFonts(files: { regular: string; bold: string }) {
  vi.resetModules();
  vi.doMock('../pdf-fonts.js', async (importOriginal) => ({
    ...(await importOriginal<typeof import('../pdf-fonts.js')>()),
    CJK_FONT_FILES: files,
  }));
  return import('../cjk-fonts.js');
}

afterEach(() => {
  vi.doUnmock('../pdf-fonts.js');
});

describe('PDF fonts with the CJK files present', () => {
  it('registers the CJK faces for a CJK language, the footer and operator text', async () => {
    const fonts = await loadFonts({ regular: READABLE, bold: READABLE });
    expect(fonts.pdfCanRender('ko')).toBe(true);
    const { doc, registered } = fakeDoc();

    expect(fonts.registerPdfFonts(doc, 'zh-TW')).toEqual({ regular: 'Cjk', bold: 'Cjk-Bold' });
    expect(fonts.registerPdfFooterFont(doc, 'Plain footer')).toBe('Helvetica');
    expect(fonts.registerPdfFooterFont(doc, '株式会社')).toBe('Cjk-Footer');
    expect(fonts.registerPdfTextFonts(doc, fonts.LATIN_FONTS, '서울 충전소')).toEqual({
      regular: 'Cjk-Text',
      bold: 'Cjk-Text-Bold',
    });
    // A CJK document font already covers operator text.
    expect(fonts.registerPdfTextFonts(doc, { regular: 'Cjk', bold: 'Cjk-Bold' }, '서울')).toEqual({
      regular: 'Cjk',
      bold: 'Cjk-Bold',
    });
    expect(registered).toEqual([
      { name: 'Cjk', face: 'NotoSansCJKtc-Regular' },
      { name: 'Cjk-Bold', face: 'NotoSansCJKtc-Bold' },
      { name: 'Cjk-Footer', face: 'NotoSansCJKsc-Regular' },
      { name: 'Cjk-Text', face: 'NotoSansCJKsc-Regular' },
      { name: 'Cjk-Text-Bold', face: 'NotoSansCJKsc-Bold' },
    ]);
  });
});

describe('PDF fonts without the CJK files', () => {
  it('falls back to Helvetica everywhere and registers nothing', async () => {
    const fonts = await loadFonts({ regular: '/nonexistent/a.ttc', bold: '/nonexistent/b.ttc' });
    const { doc, registered } = fakeDoc();
    expect(fonts.pdfCanRender('en')).toBe(true);
    expect(fonts.pdfCanRender('zh')).toBe(false);
    expect(fonts.registerPdfFonts(doc, 'ko')).toBe(fonts.LATIN_FONTS);
    expect(fonts.registerPdfFonts(doc, 'en')).toBe(fonts.LATIN_FONTS);
    expect(fonts.registerPdfFooterFont(doc, '株式会社')).toBe('Helvetica');
    expect(fonts.registerPdfTextFonts(doc, fonts.LATIN_FONTS, '서울')).toBe(fonts.LATIN_FONTS);
    expect(registered).toEqual([]);
  });
});

describe('revenueAtSites', () => {
  // Imported statically: a dynamic import inside the test can pass the 5 s timeout under load.
  it('matches nothing for no sites and lists each site as a parameter', () => {
    const dialect = new PgDialect();
    const render = (q: SQL) => dialect.sqlToQuery(q);
    expect(render(revenueAtSites([])).sql).toBe('false');
    const some = render(revenueAtSites(['sit_1', 'sit_2']));
    expect(some.sql).toBe('ri.site_id IN ($1, $2)');
    expect(some.params).toEqual(['sit_1', 'sit_2']);
  });
});
