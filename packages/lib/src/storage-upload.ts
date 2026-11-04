// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

/**
 * The browser side of a presigned upload, shared by the CSMS and the portal.
 * An upload-url route answers with how to send the file: a form POST (AWS S3
 * and S3-compatible providers) or a PUT signed for exactly the declared size
 * (Cloudflare R2). Either way the provider enforces the key, the type and the
 * size.
 */

/** The upload fields every upload-url response carries. */
export interface StorageUploadTicket {
  uploadUrl: string;
  /** Missing from an API older than PUT uploads: a POST. */
  uploadMethod?: 'POST' | 'PUT';
  /** Form fields of a POST, sent unchanged before the file. */
  fields: Record<string, string>;
  /** Headers of a PUT, sent unchanged. */
  uploadHeaders?: Record<string, string>;
}

/**
 * Sends `file` to storage as the ticket says and returns the provider's
 * response; the caller checks `ok`. A POST sends the policy fields first,
 * unchanged, and the file last (S3 ignores fields after the file). A PUT sends
 * the file as the body with the signed headers; the browser sets
 * Content-Length from the file, which must be the size the URL was signed for.
 */
export function sendStorageUpload(
  ticket: StorageUploadTicket,
  file: Blob,
  fetchImpl: typeof fetch = fetch,
): Promise<Response> {
  if (ticket.uploadMethod === 'PUT') {
    return fetchImpl(ticket.uploadUrl, {
      method: 'PUT',
      headers: ticket.uploadHeaders ?? {},
      body: file,
    });
  }
  const form = new FormData();
  for (const [name, value] of Object.entries(ticket.fields)) form.append(name, value);
  form.append('file', file);
  return fetchImpl(ticket.uploadUrl, { method: 'POST', body: form });
}
