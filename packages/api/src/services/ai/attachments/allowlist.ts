// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { IMAGE_MIMES, TEXT_DOCUMENT_MIMES } from '../core/types.js';
import type { ImageMime, TextDocumentMime } from '../core/types.js';
import { listProviderEntries } from '../core/model-registry.js';

/**
 * Attachment types accepted for AI chats and support cases (plan 3.8). The
 * declared type must be one of these; confirm then checks the bytes match.
 */
export type AttachmentMime = ImageMime | 'application/pdf' | TextDocumentMime;
export type AttachmentKind = 'image' | 'pdf' | 'text';

export const ALLOWED_ATTACHMENT_MIMES: readonly AttachmentMime[] = [
  ...IMAGE_MIMES,
  'application/pdf',
  ...TEXT_DOCUMENT_MIMES,
];

/** Long edge of a re-encoded image (the largest any registered model takes). */
export const MAX_IMAGE_LONG_EDGE_PX = 2576;
/**
 * Decoded pixel limit: a larger image is refused before it is decoded
 * (decompression bombs). 64 MP covers phone cameras up to 8000 x 8000.
 */
export const MAX_IMAGE_INPUT_PIXELS = 64_000_000;
/** Text attachments are cut to this many bytes, on a UTF-8 boundary. */
export const MAX_TEXT_BYTES = 2 * 1024 * 1024;

const EXTENSION_TYPES: Readonly<Record<string, AttachmentMime>> = {
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  png: 'image/png',
  webp: 'image/webp',
  gif: 'image/gif',
  pdf: 'application/pdf',
  csv: 'text/csv',
  txt: 'text/plain',
  log: 'text/plain',
  json: 'application/json',
  jsonl: 'application/x-ndjson',
  ndjson: 'application/x-ndjson',
};

const TYPE_ALIASES: Readonly<Record<string, AttachmentMime>> = {
  'image/jpg': 'image/jpeg',
  'image/pjpeg': 'image/jpeg',
  'text/x-log': 'text/plain',
  'application/jsonl': 'application/x-ndjson',
  'application/jsonlines': 'application/x-ndjson',
  'application/x-jsonlines': 'application/x-ndjson',
};

export function isAllowedAttachmentMime(value: string): value is AttachmentMime {
  return (ALLOWED_ATTACHMENT_MIMES as readonly string[]).includes(value);
}

export function attachmentKind(mime: AttachmentMime): AttachmentKind {
  if ((IMAGE_MIMES as readonly string[]).includes(mime)) return 'image';
  if (mime === 'application/pdf') return 'pdf';
  return 'text';
}

function extensionOf(fileName: string): string {
  const dot = fileName.lastIndexOf('.');
  return dot < 0 ? '' : fileName.slice(dot + 1).toLowerCase();
}

/**
 * The allowlisted type for an upload request, or null when it is not allowed.
 * Browsers give no type (or `application/octet-stream`) for `.log` and
 * `.jsonl`, so an empty or generic type falls back to the file extension.
 * Parameters such as `; charset=utf-8` are dropped.
 */
export function resolveDeclaredType(fileName: string, contentType: string): AttachmentMime | null {
  const normalized = (contentType.split(';')[0] ?? '').trim().toLowerCase();
  if (isAllowedAttachmentMime(normalized)) return normalized;
  const alias = TYPE_ALIASES[normalized];
  if (alias != null) return alias;
  if (normalized === '' || normalized === 'application/octet-stream') {
    return EXTENSION_TYPES[extensionOf(fileName)] ?? null;
  }
  return null;
}

/** The most PDF pages any registered model accepts; per-model limits apply at send time. */
export function maxPdfPagesAcrossModels(): number {
  let max = 0;
  for (const provider of listProviderEntries()) {
    for (const model of provider.models) {
      const pdf = model.capabilities.documents.pdf;
      if (pdf !== false && pdf.maxPages > max) max = pdf.maxPages;
    }
  }
  return max;
}
