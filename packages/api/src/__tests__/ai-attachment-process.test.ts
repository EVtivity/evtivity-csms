// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { describe, it, expect } from 'vitest';
import { crc32, deflateSync } from 'node:zlib';
import sharp from 'sharp';
import {
  inspectPdf,
  processAttachment,
  sanitizeImage,
  sanitizeText,
} from '../services/ai/attachments/process.js';
import { MAX_IMAGE_LONG_EDGE_PX, MAX_TEXT_BYTES } from '../services/ai/attachments/allowlist.js';

// Real sharp and file-type: these cases check the bytes that leave the
// pipeline, not mocks.

const MAX_PAGES = 600;

async function solidImage(
  width: number,
  height: number,
  format: 'jpeg' | 'png' | 'webp' | 'gif',
  alpha = false,
): Promise<Buffer> {
  const base = sharp({
    create: {
      width,
      height,
      channels: alpha ? 4 : 3,
      background: alpha ? { r: 10, g: 120, b: 200, alpha: 0.5 } : { r: 10, g: 120, b: 200 },
    },
  });
  return base.toFormat(format).toBuffer();
}

function pngChunk(type: string, data: Buffer): Buffer {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length);
  const typeAndData = Buffer.concat([Buffer.from(type, 'latin1'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(typeAndData));
  return Buffer.concat([length, typeAndData, crc]);
}

/** A PNG whose header claims width x height pixels, with one tiny IDAT. */
function pngClaiming(width: number, height: number): Buffer {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 0; // grayscale
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    pngChunk('IHDR', ihdr),
    pngChunk('IDAT', deflateSync(Buffer.alloc(width + 1))),
    pngChunk('IEND', Buffer.alloc(0)),
  ]);
}

function pdf(objects: string[], trailerExtra = ''): Buffer {
  const body = objects.map((o, i) => `${String(i + 1)} 0 obj\n${o}\nendobj\n`).join('');
  return Buffer.from(
    `%PDF-1.7\n${body}trailer\n<< /Root 1 0 R /Size ${String(objects.length + 1)} ${trailerExtra}>>\n%%EOF\n`,
    'latin1',
  );
}

function pdfWithPages(pages: number, trailerExtra = ''): Buffer {
  const kids = Array.from({ length: pages }, (_, i) => `${String(i + 3)} 0 R`).join(' ');
  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    `<< /Type /Pages /Kids [${kids}] /Count ${String(pages)} >>`,
    ...Array.from({ length: pages }, () => '<< /Type /Page /Parent 2 0 R >>'),
  ];
  return pdf(objects, trailerExtra);
}

/** PDF 1.5 layout: the page objects live in a compressed object stream. */
function pdfWithObjectStream(pages: number): Buffer {
  const inner = Array.from({ length: pages }, () => '<< /Type /Page /Parent 2 0 R >>').join('\n');
  const compressed = deflateSync(Buffer.from(inner, 'latin1'));
  const head = Buffer.from(
    `%PDF-1.7\n1 0 obj\n<< /Type /Catalog /Pages 2 0 R >>\nendobj\n` +
      `2 0 obj\n<< /Type /Pages /Count ${String(pages)} >>\nendobj\n` +
      `3 0 obj\n<< /Type /ObjStm /N ${String(pages)} /First 0 /Filter /FlateDecode /Length ${String(compressed.length)} >>\nstream\n`,
    'latin1',
  );
  const tail = Buffer.from('\nendstream\nendobj\ntrailer\n<< /Root 1 0 R >>\n%%EOF\n', 'latin1');
  return Buffer.concat([head, compressed, tail]);
}

describe('processAttachment', () => {
  it('TC-AI-U-01 accepts a JPEG and re-encodes it as JPEG', async () => {
    const res = await processAttachment(await solidImage(64, 32, 'jpeg'), 'image/jpeg', {
      maxPdfPages: MAX_PAGES,
    });
    expect(res).toMatchObject({ ok: true, contentType: 'image/jpeg', kind: 'image', width: 64 });
  });

  it('TC-AI-U-02 accepts a PNG with transparency and keeps it PNG', async () => {
    const res = await processAttachment(await solidImage(32, 32, 'png', true), 'image/png', {
      maxPdfPages: MAX_PAGES,
    });
    expect(res).toMatchObject({ ok: true, contentType: 'image/png', kind: 'image' });
  });

  it('TC-AI-U-03 accepts a WebP and outputs JPEG', async () => {
    const res = await processAttachment(await solidImage(40, 20, 'webp'), 'image/webp', {
      maxPdfPages: MAX_PAGES,
    });
    expect(res).toMatchObject({ ok: true, contentType: 'image/jpeg', width: 40, height: 20 });
  });

  it('accepts a GIF and keeps only its first frame', async () => {
    const frame = (color: string) =>
      sharp({ create: { width: 20, height: 30, channels: 3, background: color } })
        .png()
        .toBuffer();
    const animated = await sharp([await frame('#ff0000'), await frame('#0000ff')], {
      join: { animated: true },
    })
      .gif({ loop: 0 })
      .toBuffer();
    expect((await sharp(animated).metadata()).pages).toBe(2);

    const res = await processAttachment(animated, 'image/gif', { maxPdfPages: MAX_PAGES });
    expect(res).toMatchObject({ ok: true, width: 20, height: 30 });
    if (res.ok) expect((await sharp(res.bytes).metadata()).pages ?? 1).toBe(1);
  });

  it('TC-AI-U-04 accepts a PDF and counts its pages', async () => {
    const res = await processAttachment(pdfWithPages(3), 'application/pdf', {
      maxPdfPages: MAX_PAGES,
    });
    expect(res).toMatchObject({ ok: true, contentType: 'application/pdf', pageCount: 3 });
  });

  it('TC-AI-U-05 accepts CSV, log and JSONL text', async () => {
    for (const [text, type] of [
      ['station,kwh\nCS-1,12.5\n', 'text/csv'],
      ['2026-10-09T10:00:00Z INFO boot\n', 'text/plain'],
      ['{"action":"BootNotification"}\n{"action":"Heartbeat"}\n', 'application/x-ndjson'],
      ['{"a":1}', 'application/json'],
    ] as const) {
      const res = await processAttachment(Buffer.from(text), type, { maxPdfPages: MAX_PAGES });
      expect(res).toMatchObject({ ok: true, contentType: type, kind: 'text' });
    }
  });

  it('TC-AI-U-07 refuses a PNG declared as PDF', async () => {
    const res = await processAttachment(await solidImage(8, 8, 'png'), 'application/pdf', {
      maxPdfPages: MAX_PAGES,
    });
    expect(res).toMatchObject({ ok: false, code: 'AI_ATTACHMENT_REJECTED' });
  });

  it('TC-AI-U-07 refuses HTML declared as PNG', async () => {
    const html = Buffer.from('<html><body><script>alert(1)</script></body></html>');
    const res = await processAttachment(html, 'image/png', { maxPdfPages: MAX_PAGES });
    expect(res).toMatchObject({ ok: false, code: 'AI_ATTACHMENT_REJECTED' });
  });

  it('TC-AI-U-07 refuses a JPEG declared as WebP', async () => {
    const res = await processAttachment(await solidImage(8, 8, 'jpeg'), 'image/webp', {
      maxPdfPages: MAX_PAGES,
    });
    expect(res).toMatchObject({ ok: false, code: 'AI_ATTACHMENT_REJECTED' });
  });

  it('TC-AI-U-07 refuses binary content declared as text', async () => {
    for (const bytes of [pdfWithPages(1), await solidImage(8, 8, 'png')]) {
      const res = await processAttachment(bytes, 'text/plain', { maxPdfPages: MAX_PAGES });
      expect(res).toMatchObject({ ok: false, code: 'AI_ATTACHMENT_REJECTED' });
    }
  });

  it('refuses an empty file', async () => {
    const res = await processAttachment(Buffer.alloc(0), 'text/plain', { maxPdfPages: MAX_PAGES });
    expect(res).toMatchObject({ ok: false, code: 'AI_ATTACHMENT_REJECTED' });
  });
});

describe('sanitizeImage', () => {
  it('TC-AI-U-08 strips EXIF and GPS metadata', async () => {
    const withExif = await sharp({
      create: { width: 50, height: 40, channels: 3, background: '#808080' },
    })
      .withExif({
        IFD0: { Make: 'TestCam', Model: 'Secret Model', Copyright: 'owner' },
        IFD3: { GPSLatitudeRef: 'N', GPSLatitude: '52/1 31/1 0/1' },
      })
      .jpeg()
      .toBuffer();
    expect((await sharp(withExif).metadata()).exif).toBeDefined();

    const res = await sanitizeImage(withExif);
    expect(res.ok).toBe(true);
    if (res.ok) {
      const meta = await sharp(res.bytes).metadata();
      expect(meta.exif).toBeUndefined();
      expect(meta.icc).toBeUndefined();
      expect(meta.xmp).toBeUndefined();
      expect(res.bytes.includes(Buffer.from('Secret Model'))).toBe(false);
    }
  });

  it('TC-AI-U-08 applies the EXIF orientation before dropping it', async () => {
    const rotated = await sharp({
      create: { width: 200, height: 100, channels: 3, background: '#000000' },
    })
      .withMetadata({ orientation: 6 })
      .jpeg()
      .toBuffer();
    const res = await sanitizeImage(rotated);
    expect(res).toMatchObject({ ok: true, width: 100, height: 200 });
  });

  it('TC-AI-U-08 resizes the long edge to the limit and never enlarges', async () => {
    const big = await sanitizeImage(await solidImage(5000, 1000, 'jpeg'));
    expect(big).toMatchObject({ ok: true, width: MAX_IMAGE_LONG_EDGE_PX });
    if (big.ok) expect(big.height).toBe(Math.round((1000 * MAX_IMAGE_LONG_EDGE_PX) / 5000));

    const small = await sanitizeImage(await solidImage(300, 200, 'jpeg'));
    expect(small).toMatchObject({ ok: true, width: 300, height: 200 });
  });

  it('TC-AI-U-09 refuses a decompression bomb before decoding it', async () => {
    const res = await sanitizeImage(pngClaiming(30_000, 30_000));
    expect(res).toMatchObject({ ok: false, code: 'AI_ATTACHMENT_TOO_LARGE' });
  });

  it('removes data appended to an image (polyglot)', async () => {
    const payload = Buffer.from('<html><script>fetch("//evil")</script></html>PK\u0003\u0004');
    const polyglot = Buffer.concat([await solidImage(16, 16, 'jpeg'), payload]);
    const res = await processAttachment(polyglot, 'image/jpeg', { maxPdfPages: MAX_PAGES });
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.bytes.includes(Buffer.from('<script>'))).toBe(false);
      expect(res.bytes.includes(Buffer.from('PK\u0003\u0004'))).toBe(false);
    }
  });

  it('removes a script hidden in a PNG text chunk (polyglot)', async () => {
    const png = await solidImage(16, 16, 'png');
    const iend = png.length - 12;
    const text = pngChunk('tEXt', Buffer.from('Comment\u0000<script>alert(1)</script>', 'latin1'));
    const polyglot = Buffer.concat([png.subarray(0, iend), text, png.subarray(iend)]);
    expect(polyglot.includes(Buffer.from('<script>'))).toBe(true);

    const res = await processAttachment(polyglot, 'image/png', { maxPdfPages: MAX_PAGES });
    expect(res.ok).toBe(true);
    if (res.ok) expect(res.bytes.includes(Buffer.from('<script>'))).toBe(false);
  });

  it('refuses an image that does not decode', async () => {
    const png = await solidImage(16, 16, 'png');
    const res = await sanitizeImage(png.subarray(0, 40));
    expect(res).toMatchObject({ ok: false, code: 'AI_ATTACHMENT_REJECTED' });
  });
});

describe('inspectPdf', () => {
  it('TC-AI-U-10 refuses an encrypted PDF', () => {
    const res = inspectPdf(pdfWithPages(1, '/Encrypt 9 0 R '), MAX_PAGES);
    expect(res).toMatchObject({ ok: false, code: 'AI_ATTACHMENT_REJECTED' });
    if (!res.ok) expect(res.reason).toMatch(/encrypted/);
  });

  it('TC-AI-U-10 refuses a PDF over the page limit', () => {
    const res = inspectPdf(pdfWithPages(4), 3);
    expect(res).toMatchObject({ ok: false, code: 'AI_ATTACHMENT_TOO_LARGE' });
  });

  it('counts pages inside compressed object streams', () => {
    expect(inspectPdf(pdfWithObjectStream(5), MAX_PAGES)).toMatchObject({
      ok: true,
      pageCount: 5,
    });
    expect(inspectPdf(pdfWithObjectStream(5), 4)).toMatchObject({
      ok: false,
      code: 'AI_ATTACHMENT_TOO_LARGE',
    });
  });

  it('refuses a truncated PDF and one without pages', () => {
    const full = pdfWithPages(2);
    expect(inspectPdf(full.subarray(0, full.length - 8), MAX_PAGES)).toMatchObject({
      ok: false,
    });
    expect(inspectPdf(pdf(['<< /Type /Catalog >>']), MAX_PAGES)).toMatchObject({ ok: false });
  });
});

describe('sanitizeText', () => {
  it('refuses invalid UTF-8 and NUL bytes', () => {
    expect(sanitizeText(Buffer.from([0x61, 0xff, 0x62]), 'text/plain')).toMatchObject({
      ok: false,
    });
    expect(sanitizeText(Buffer.from('a\u0000b'), 'text/plain')).toMatchObject({ ok: false });
  });

  it('cuts text over 2 MB on a character boundary', () => {
    // 'é' is 2 bytes in UTF-8; an odd prefix puts a character across the cut.
    const text = 'x' + 'é'.repeat(MAX_TEXT_BYTES);
    const res = sanitizeText(Buffer.from(text, 'utf8'), 'text/plain');
    expect(res).toMatchObject({ ok: true, truncated: true });
    if (res.ok) {
      expect(res.bytes.length).toBeLessThanOrEqual(MAX_TEXT_BYTES);
      expect(res.bytes.length).toBe(MAX_TEXT_BYTES - 1);
      expect(() => new TextDecoder('utf-8', { fatal: true }).decode(res.bytes)).not.toThrow();
    }
  });

  it('keeps text under the limit unchanged', () => {
    const res = sanitizeText(Buffer.from('hello'), 'text/csv');
    expect(res).toMatchObject({ ok: true, truncated: false, contentType: 'text/csv' });
  });
});
