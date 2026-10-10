// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { inflateSync } from 'node:zlib';
import { fileTypeFromBuffer } from 'file-type';
import sharp from 'sharp';
import {
  attachmentKind,
  MAX_IMAGE_INPUT_PIXELS,
  MAX_IMAGE_LONG_EDGE_PX,
  MAX_TEXT_BYTES,
} from './allowlist.js';
import type { AttachmentKind, AttachmentMime } from './allowlist.js';

// The API process re-encodes uploads one at a time per request; libvips'
// operation cache only holds memory between unrelated images.
sharp.cache(false);

/** Why an upload was refused. The route maps it to an error code. */
export type AttachmentRejection =
  | { code: 'AI_ATTACHMENT_REJECTED'; reason: string }
  | { code: 'AI_ATTACHMENT_TOO_LARGE'; reason: string };

export interface ProcessedAttachment {
  bytes: Buffer;
  /** The type of `bytes`: an image is re-encoded as JPEG or PNG. */
  contentType: AttachmentMime;
  kind: AttachmentKind;
  width?: number;
  height?: number;
  pageCount?: number;
  /** True when a text file was cut to `MAX_TEXT_BYTES`. */
  truncated?: boolean;
}

export type ProcessResult =
  | ({ ok: true } & ProcessedAttachment)
  | ({ ok: false } & AttachmentRejection);

function rejected(reason: string): ProcessResult {
  return { ok: false, code: 'AI_ATTACHMENT_REJECTED', reason };
}

/**
 * Sniff the bytes, check them against the declared type, and sanitize them
 * (plan 3.8 steps 2 and 3). Never trusts the declared type or file name.
 */
export async function processAttachment(
  bytes: Buffer,
  declaredType: AttachmentMime,
  options: { maxPdfPages: number },
): Promise<ProcessResult> {
  if (bytes.length === 0) return rejected('empty');
  const kind = attachmentKind(declaredType);
  const sniffed = await fileTypeFromBuffer(bytes);

  if (kind === 'text') {
    // A text file has no binary signature. Anything file-type recognizes
    // (an image, a PDF, an archive, XML) is not the declared text type.
    if (sniffed != null) return rejected(`sniffed ${sniffed.mime}, declared ${declaredType}`);
    return sanitizeText(bytes, declaredType);
  }

  if (sniffed?.mime !== declaredType) {
    return rejected(`sniffed ${sniffed?.mime ?? 'unknown'}, declared ${declaredType}`);
  }
  if (kind === 'image') return sanitizeImage(bytes);
  return inspectPdf(bytes, options.maxPdfPages);
}

/**
 * Re-encode an image: EXIF, GPS and every other metadata dropped (sharp keeps
 * none unless asked), orientation applied, long edge at most
 * `MAX_IMAGE_LONG_EDGE_PX`, first frame only. Output is PNG when the image has
 * an alpha channel, else JPEG. Re-encoding drops any bytes appended to the
 * image (polyglots). `limitInputPixels` refuses decompression bombs.
 */
export async function sanitizeImage(bytes: Buffer): Promise<ProcessResult> {
  try {
    const input = sharp(bytes, {
      limitInputPixels: MAX_IMAGE_INPUT_PIXELS,
      failOn: 'error',
      animated: false,
    });
    const meta = await input.metadata();
    if (meta.width * meta.height > MAX_IMAGE_INPUT_PIXELS) {
      return {
        ok: false,
        code: 'AI_ATTACHMENT_TOO_LARGE',
        reason: `image of ${String(meta.width)}x${String(meta.height)} pixels exceeds the pixel limit`,
      };
    }
    const resized = input.rotate().resize({
      width: MAX_IMAGE_LONG_EDGE_PX,
      height: MAX_IMAGE_LONG_EDGE_PX,
      fit: 'inside',
      withoutEnlargement: true,
    });
    const usePng = meta.hasAlpha;
    const encoded = usePng
      ? resized.png({ compressionLevel: 9 })
      : resized.jpeg({ quality: 85, mozjpeg: true });
    const { data, info } = await encoded.toBuffer({ resolveWithObject: true });
    return {
      ok: true,
      bytes: data,
      contentType: usePng ? 'image/png' : 'image/jpeg',
      kind: 'image',
      width: info.width,
      height: info.height,
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    if (/pixel limit/i.test(message)) {
      return { ok: false, code: 'AI_ATTACHMENT_TOO_LARGE', reason: message };
    }
    return rejected(`image could not be decoded: ${message}`);
  }
}

/**
 * Check a text attachment: valid UTF-8 without NUL bytes, cut to
 * `MAX_TEXT_BYTES` on a character boundary.
 */
export function sanitizeText(bytes: Buffer, declaredType: AttachmentMime): ProcessResult {
  let end = Math.min(bytes.length, MAX_TEXT_BYTES);
  const truncated = end < bytes.length;
  if (truncated) {
    // Step back over UTF-8 continuation bytes (10xxxxxx) to a character start.
    while (end > 0 && ((bytes[end] ?? 0) & 0xc0) === 0x80) end--;
  }
  const kept = bytes.subarray(0, end);
  if (kept.includes(0)) return rejected('text contains NUL bytes');
  try {
    new TextDecoder('utf-8', { fatal: true }).decode(kept);
  } catch (err) {
    return rejected(`text is not valid UTF-8: ${err instanceof Error ? err.message : String(err)}`);
  }
  return {
    ok: true,
    bytes: Buffer.from(kept),
    contentType: declaredType,
    kind: 'text',
    truncated,
  };
}

// Inflate budget for compressed object streams while counting pages.
const PDF_INFLATE_BUDGET_BYTES = 64 * 1024 * 1024;
const PAGE_OBJECT = /\/Type\s*\/Page(?![A-Za-z])/g;

function countPages(text: string): number {
  return text.match(PAGE_OBJECT)?.length ?? 0;
}

/**
 * Inspect a PDF without rendering it: `%PDF-` header and `%%EOF` trailer,
 * no encryption dictionary, and a page count between 1 and `maxPages`.
 * Pages inside compressed object streams (PDF 1.5) are counted by inflating
 * those streams within a fixed budget.
 */
export function inspectPdf(bytes: Buffer, maxPages: number): ProcessResult {
  const raw = bytes.toString('latin1');
  if (!raw.startsWith('%PDF-')) return rejected('missing PDF header');
  if (!raw.slice(-4096).includes('%%EOF')) return rejected('PDF is truncated');
  if (/\/Encrypt\b/.test(raw)) return rejected('PDF is encrypted');

  let pageCount = countPages(raw);
  let budget = PDF_INFLATE_BUDGET_BYTES;
  // Linear scan: each `stream` keyword, with the object header before it as
  // its dictionary.
  let pos = 0;
  for (;;) {
    const keyword = raw.indexOf('stream', pos);
    if (keyword < 0) break;
    pos = keyword + 6;
    if (raw.slice(keyword - 3, keyword) === 'end') continue;
    const objStart = raw.lastIndexOf(' obj', keyword);
    const dict = raw.slice(Math.max(objStart, keyword - 4096, 0), keyword);
    let start = keyword + 6;
    if (raw[start] === '\r') start++;
    if (raw[start] === '\n') start++;
    const end = raw.indexOf('endstream', start);
    if (end < 0) break;
    pos = end + 9;
    if (!/\/Type\s*\/ObjStm/.test(dict) || !/\/FlateDecode/.test(dict)) continue;
    if (budget <= 0) return rejected('PDF object streams exceed the inspection budget');
    try {
      const inflated = inflateSync(bytes.subarray(start, end), { maxOutputLength: budget });
      budget -= inflated.length;
      const text = inflated.toString('latin1');
      if (/\/Encrypt\b/.test(text)) return rejected('PDF is encrypted');
      pageCount += countPages(text);
    } catch (err) {
      return rejected(
        `PDF object stream could not be read: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  if (pageCount === 0) return rejected('PDF has no readable pages');
  if (pageCount > maxPages) {
    return {
      ok: false,
      code: 'AI_ATTACHMENT_TOO_LARGE',
      reason: `PDF has ${String(pageCount)} pages, the limit is ${String(maxPages)}`,
    };
  }
  return {
    ok: true,
    bytes,
    contentType: 'application/pdf',
    kind: 'pdf',
    pageCount,
  };
}
