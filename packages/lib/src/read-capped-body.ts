// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

// Bounded reads of HTTP response bodies from hosts the CSMS does not control
// (OCSP responders, CRL servers, OCPI partners, webhook receivers). A body is
// read as a stream and cancelled once it passes the cap, so a server that
// streams without end costs at most the cap plus one chunk of memory.

/** A response body larger than the cap (declared or streamed). */
export class ResponseTooLargeError extends Error {
  constructor(readonly maxBytes: number) {
    super(`Response body exceeds ${String(maxBytes)} bytes`);
    this.name = 'ResponseTooLargeError';
  }
}

/** A fetch Response (global or undici, whose body stream type differs). */
interface BodyResponse {
  headers: { get(name: string): string | null };
  body: { getReader(): ReadableStreamDefaultReader<Uint8Array>; cancel(): Promise<void> } | null;
}

/**
 * Reads the whole body when it is at most `maxBytes`; else cancels the stream
 * and throws ResponseTooLargeError. A Content-Length above the cap is refused
 * before any read.
 */
export async function readCappedBody(res: BodyResponse, maxBytes: number): Promise<Buffer> {
  const declared = Number(res.headers.get('content-length') ?? Number.NaN);
  if (Number.isFinite(declared) && declared > maxBytes) {
    await cancelQuietly(res.body);
    throw new ResponseTooLargeError(maxBytes);
  }
  if (res.body == null) return Buffer.alloc(0);
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const chunk = await reader.read();
    if (chunk.done) break;
    total += chunk.value.byteLength;
    if (total > maxBytes) {
      await reader.cancel().catch(() => {
        // fail-open: the read is refused either way; a failed cancel only leaves the socket to the timeout
      });
      throw new ResponseTooLargeError(maxBytes);
    }
    chunks.push(chunk.value);
  }
  return Buffer.concat(chunks);
}

/**
 * Reads at most `maxBytes` of the body as text for a log line, then cancels
 * the rest; never throws (an error reply must not fail on its own body).
 */
export async function readBodyPrefix(res: BodyResponse, maxBytes: number): Promise<string> {
  if (res.body == null) return '';
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (total < maxBytes) {
      const chunk = await reader.read();
      if (chunk.done) break;
      chunks.push(chunk.value);
      total += chunk.value.byteLength;
    }
  } catch {
    // fail-open: a broken error body leaves what was read so far for the log
  } finally {
    await reader.cancel().catch(() => {
      // fail-open: the prefix is already read; the timeout ends the socket
    });
  }
  return Buffer.concat(chunks).subarray(0, maxBytes).toString('utf8');
}

async function cancelQuietly(body: BodyResponse['body']): Promise<void> {
  try {
    await body?.cancel();
  } catch {
    // fail-open: the body is refused either way; the timeout ends the socket
  }
}
