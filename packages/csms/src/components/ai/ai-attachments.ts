// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { AI_LIMIT_SETTINGS } from '@evtivity/lib/ai-config';
import { api } from '@/lib/api';

/**
 * Chat attachments (plan 3.8): the API returns a presigned POST to a
 * quarantine key, the browser uploads the file there, and the confirm call
 * sniffs, sanitizes and stores it. The message then names the attachment ids.
 * The server enforces every limit again; the checks here only fail fast.
 */

/** The types the upload pipeline accepts, by MIME type. */
export const AI_ATTACHMENT_TYPES: Readonly<Record<string, 'image' | 'document'>> = {
  'image/jpeg': 'image',
  'image/png': 'image',
  'image/webp': 'image',
  'image/gif': 'image',
  'application/pdf': 'document',
  'text/csv': 'document',
  'text/plain': 'document',
  'application/json': 'document',
  'application/x-ndjson': 'document',
};

// Browsers leave `File.type` empty for some text formats.
const TYPE_BY_EXTENSION: Readonly<Record<string, string>> = {
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

/** The `accept` attribute of the file input. */
export const AI_ATTACHMENT_ACCEPT = [
  ...Object.keys(AI_ATTACHMENT_TYPES),
  ...Object.keys(TYPE_BY_EXTENSION).map((e) => `.${e}`),
].join(',');

export const AI_ATTACHMENT_MAX_BYTES = AI_LIMIT_SETTINGS['ai.attachments.maxBytes'].defaultValue;
export const AI_ATTACHMENT_MAX_PER_MESSAGE =
  AI_LIMIT_SETTINGS['ai.attachments.maxPerMessage'].defaultValue;

/** The MIME type to declare for a file, or null when it is not allowed. */
export function attachmentMimeType(file: File): string | null {
  const declared = file.type.toLowerCase();
  if (declared !== '' && Object.hasOwn(AI_ATTACHMENT_TYPES, declared)) return declared;
  const ext = file.name.toLowerCase().split('.').pop() ?? '';
  const byExt = TYPE_BY_EXTENSION[ext];
  if (byExt == null) return null;
  // A browser-declared type that disagrees with the extension is left to the server's sniffing.
  return declared === '' || declared === 'application/octet-stream' ? byExt : null;
}

export type AttachmentRejection = 'typeNotAllowed' | 'tooLarge' | 'tooMany';

/** A client-side check before upload; the server checks again by content. */
export function checkAttachment(file: File, alreadySelected: number): AttachmentRejection | null {
  if (alreadySelected >= AI_ATTACHMENT_MAX_PER_MESSAGE) return 'tooMany';
  if (attachmentMimeType(file) == null) return 'typeNotAllowed';
  if (file.size > AI_ATTACHMENT_MAX_BYTES) return 'tooLarge';
  return null;
}

interface UploadTarget {
  attachmentId: string;
  uploadUrl: string;
  fields: Record<string, string>;
  expiresAt: string;
}

/** A stored, sanitized attachment (`POST /v1/assistant/attachments/:id/confirm`). */
export interface UploadedAttachment {
  id: string;
  fileName: string;
  contentType: string;
  kind: 'image' | 'pdf' | 'text';
  sizeBytes: number;
}

const BASE = '/v1/assistant/attachments';
const attachmentPath = (id: string): string => `${BASE}/${encodeURIComponent(id)}`;

/**
 * Uploads one file: presigned POST to quarantine, then the confirm call that
 * sniffs and sanitizes it. The attachment belongs to the user until a message
 * names it in `attachmentIds`.
 */
export async function uploadAiAttachment(file: File): Promise<UploadedAttachment> {
  const target = await api.post<UploadTarget>(`${BASE}/upload-url`, {
    fileName: file.name,
    contentType: attachmentMimeType(file) ?? file.type,
    fileSize: file.size,
  });
  const form = new FormData();
  for (const [key, value] of Object.entries(target.fields)) form.append(key, value);
  // S3 ignores every form field after the file.
  form.append('file', file);
  const res = await fetch(target.uploadUrl, { method: 'POST', body: form });
  if (!res.ok) throw new Error(`upload failed with HTTP ${String(res.status)}`);
  return api.post<UploadedAttachment>(`${attachmentPath(target.attachmentId)}/confirm`, {});
}

/** Removes an uploaded attachment the user took off the message. */
export function deleteAiAttachment(id: string): Promise<unknown> {
  return api.delete(attachmentPath(id));
}

/** A short-lived download link of a stored attachment. */
export async function aiAttachmentDownloadUrl(id: string): Promise<string> {
  const { downloadUrl } = await api.get<{ downloadUrl: string }>(
    `${attachmentPath(id)}/download-url`,
  );
  return downloadUrl;
}
