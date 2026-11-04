// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { describe, expect, it, vi } from 'vitest';
import { sendStorageUpload } from '../storage-upload.js';

function recordingFetch(status = 200) {
  return vi.fn((_url: string, _init: RequestInit) =>
    Promise.resolve(new Response(null, { status })),
  );
}

describe('sendStorageUpload', () => {
  const file = new Blob(['12345'], { type: 'image/png' });

  it('posts the policy fields first, unchanged, and the file last', async () => {
    const fetchImpl = recordingFetch(204);
    const res = await sendStorageUpload(
      {
        uploadUrl: 'https://s3.test/b',
        uploadMethod: 'POST',
        fields: { key: 'k', Policy: 'p' },
        uploadHeaders: {},
      },
      file,
      fetchImpl as unknown as typeof fetch,
    );
    expect(res.status).toBe(204);
    const [url, init] = fetchImpl.mock.calls[0]!;
    expect(url).toBe('https://s3.test/b');
    expect(init.method).toBe('POST');
    const form = init.body as FormData;
    expect([...form.keys()]).toEqual(['key', 'Policy', 'file']);
    expect(form.get('key')).toBe('k');
  });

  it('posts a ticket without uploadMethod (an API older than PUT uploads)', async () => {
    const fetchImpl = recordingFetch(204);
    await sendStorageUpload(
      { uploadUrl: 'https://s3.test/b', fields: { key: 'k' } },
      file,
      fetchImpl as unknown as typeof fetch,
    );
    expect(fetchImpl.mock.calls[0]![1].method).toBe('POST');
  });

  it('puts the file as the body with the signed headers and no form', async () => {
    const fetchImpl = recordingFetch(200);
    const res = await sendStorageUpload(
      {
        uploadUrl: 'https://acct.r2.cloudflarestorage.com/files/k?X-Amz-Signature=s',
        uploadMethod: 'PUT',
        fields: {},
        uploadHeaders: { 'Content-Type': 'image/png' },
      },
      file,
      fetchImpl as unknown as typeof fetch,
    );
    expect(res.ok).toBe(true);
    const [url, init] = fetchImpl.mock.calls[0]!;
    expect(url).toBe('https://acct.r2.cloudflarestorage.com/files/k?X-Amz-Signature=s');
    expect(init).toEqual({
      method: 'PUT',
      headers: { 'Content-Type': 'image/png' },
      body: file,
    });
  });

  it('returns a refusal for the caller to report', async () => {
    const res = await sendStorageUpload(
      { uploadUrl: 'https://r2.test', uploadMethod: 'PUT', fields: {}, uploadHeaders: {} },
      file,
      recordingFetch(403) as unknown as typeof fetch,
    );
    expect(res.status).toBe(403);
  });
});
