// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import crypto from 'node:crypto';
import type { FastifyBaseLogger } from 'fastify';
import {
  buildStationImageQuarantineKey,
  buildStationImageS3Key,
  generateUploadPost,
  QUARANTINE_PREFIX,
} from './s3.service.js';
import type { DownloadOptions, S3Config } from './s3.service.js';
import { displayFileName, finalizeUpload } from './ai/attachments/upload-flow.js';

/**
 * Station image uploads go through the attachment pipeline:
 * a presigned POST into quarantine whose policy S3 enforces (this key, this
 * type, at most the declared size), then confirm reads the object, sniffs
 * the bytes against the declared type, re-encodes the image (metadata
 * dropped, long edge at most 2576 px, JPEG or PNG) and stores the clean file
 * under `stations/{stationId}/`. Raster types only: an SVG can carry script.
 */

export const STATION_IMAGE_MIME_TYPES = [
  'image/jpeg',
  'image/png',
  'image/gif',
  'image/webp',
] as const;
export type StationImageMime = (typeof STATION_IMAGE_MIME_TYPES)[number];

/** Largest station image upload. */
export const STATION_IMAGE_MAX_BYTES = 10 * 1024 * 1024;

export interface StationImageUploadTicket {
  /** Form POST target. */
  uploadUrl: string;
  /** Form fields to send before the `file` field, unchanged. */
  fields: Record<string, string>;
  /** The quarantine key to name at confirm. */
  s3Key: string;
  s3Bucket: string;
}

/** Presigned POST into quarantine for one station image of at most `fileSize` bytes. */
export async function requestStationImageUpload(
  s3: S3Config,
  stationId: string,
  request: { fileName: string; contentType: StationImageMime; fileSize: number },
): Promise<StationImageUploadTicket> {
  const key = buildStationImageQuarantineKey(stationId, crypto.randomUUID(), request.fileName);
  const post = await generateUploadPost(s3, key, request.contentType, request.fileSize);
  return { uploadUrl: post.url, fields: post.fields, s3Key: key, s3Bucket: s3.bucket };
}

const UUID = '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}';

/**
 * The file id and name of a quarantine key issued for this station, or null
 * for any other key (another station, outside quarantine, an altered name).
 */
export function parseStationImageQuarantineKey(
  stationId: string,
  s3Key: string,
): { fileId: string; fileName: string } | null {
  const prefix = `${QUARANTINE_PREFIX}stations/${stationId}/`;
  const rest = s3Key.startsWith(prefix) ? s3Key.slice(prefix.length) : '';
  const match = new RegExp(`^(${UUID})/([A-Za-z0-9_-][A-Za-z0-9._-]{0,99})$`).exec(rest);
  if (match?.[1] == null || match[2] == null) return null;
  return { fileId: match[1], fileName: match[2] };
}

/** The clean key confirm stores a quarantined upload under (deterministic, so a retry finds it). */
export function stationImageCleanKey(stationId: string, fileId: string, fileName: string): string {
  return buildStationImageS3Key(stationId, fileId, fileName);
}

export interface FinalizedStationImage {
  s3Key: string;
  fileName: string;
  fileSize: number;
  contentType: string;
}

/**
 * Check, re-encode and store a quarantined station image. Throws 400
 * `AI_ATTACHMENT_REJECTED` (nothing uploaded, another stored type, bytes of
 * another type) or `AI_ATTACHMENT_TOO_LARGE` (larger than declared), and
 * deletes the quarantine object either way.
 */
export async function finalizeStationImage(
  s3: S3Config,
  quarantine: { s3Key: string; fileId: string; fileName: string },
  stationId: string,
  declared: { fileName: string; contentType: StationImageMime; fileSize: number },
  log: FastifyBaseLogger,
): Promise<FinalizedStationImage> {
  const cleanKey = stationImageCleanKey(stationId, quarantine.fileId, quarantine.fileName);
  const processed = await finalizeUpload(
    {
      s3,
      quarantineKey: quarantine.s3Key,
      cleanKey,
      declaredType: declared.contentType,
      maxBytes: Math.min(declared.fileSize, STATION_IMAGE_MAX_BYTES),
    },
    log,
  );
  return {
    s3Key: cleanKey,
    fileName: displayFileName(declared.fileName, processed.contentType),
    fileSize: processed.bytes.length,
    contentType: processed.contentType,
  };
}

const INLINE_IMAGE_TYPES: ReadonlySet<string> = new Set(STATION_IMAGE_MIME_TYPES);

/**
 * How a station image downloads: a raster type the pipeline stores is served
 * inline with that type; anything else (an SVG stored before v0.1.48, a
 * client-declared type) as an attachment of `application/octet-stream`, so a
 * browser never renders it.
 */
export function stationImageDownloadOptions(image: {
  fileName: string;
  contentType: string;
}): DownloadOptions {
  return INLINE_IMAGE_TYPES.has(image.contentType)
    ? { fileName: image.fileName, contentType: image.contentType, disposition: 'inline' }
    : { fileName: image.fileName, contentType: 'application/octet-stream' };
}
