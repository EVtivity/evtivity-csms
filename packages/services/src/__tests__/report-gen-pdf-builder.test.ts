// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

// PdfReportBuilder edges: the text of each cell type, given column widths, a
// table without rows, and the default logo when pdfkit refuses the company logo.

import { afterEach, describe, expect, it, vi } from 'vitest';
import PDFDocument from 'pdfkit';
import { PdfReportBuilder } from '../report-generators/pdf-builder.js';
import type { PdfBranding } from '../pdf-branding.js';

const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==',
  'base64',
);
const BRANDING: PdfBranding = { logo: PNG, isDefaultLogo: false, footer: '' };

afterEach(() => {
  vi.restoreAllMocks();
});

describe('PdfReportBuilder cells', () => {
  it('writes null as empty, numbers, booleans and bigints as text, objects as JSON', async () => {
    const text = vi.spyOn(PDFDocument.prototype, 'text');
    const pdf = await new PdfReportBuilder('en', BRANDING)
      .addTable(
        ['A', 'B', 'C', 'D', 'E', 'F'],
        [[null, 12.5, true, 10n, { k: 1 }, 'plain']],
        [60, 60, 60, 60, 80, 40],
      )
      .build();
    expect(pdf.subarray(0, 4).toString()).toBe('%PDF');
    const drawn = text.mock.calls.map((c) => [
      c[0],
      (c[3] as { width?: number } | undefined)?.width,
    ]);
    expect(drawn).toEqual(
      expect.arrayContaining([
        ['', 54],
        ['12.5', 54],
        ['true', 54],
        ['10', 54],
        ['{"k":1}', 74],
        ['plain', 34],
      ]),
    );
  });

  it('draws a header for a table without rows and a missing cell as empty', async () => {
    const text = vi.spyOn(PDFDocument.prototype, 'text');
    await new PdfReportBuilder('en', BRANDING)
      .addTable(['Only'], [])
      .addTable(['X', 'Y'], [['1']])
      .build();
    const labels = text.mock.calls.map((c) => c[0]);
    expect(labels).toContain('Only');
    expect(labels).toEqual(expect.arrayContaining(['X', 'Y', '1', '']));
  });

  it('falls back to the default logo when pdfkit refuses the company logo', async () => {
    const image = vi.spyOn(PDFDocument.prototype, 'image');
    const pdf = await new PdfReportBuilder('en', {
      logo: Buffer.from('not an image'),
      isDefaultLogo: false,
      footer: '',
    })
      .addTitle('Report')
      .build();
    expect(image).toHaveBeenCalledTimes(2);
    expect(Buffer.isBuffer(image.mock.calls[1]![0])).toBe(true);
    expect(pdf.length).toBeGreaterThan(0);
  });
});
