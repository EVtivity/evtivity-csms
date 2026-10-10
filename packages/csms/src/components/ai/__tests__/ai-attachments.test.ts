// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { afterEach, describe, expect, it, vi } from 'vitest';

const { postMock, getMock, deleteMock } = vi.hoisted(() => ({
  postMock: vi.fn(),
  getMock: vi.fn(),
  deleteMock: vi.fn(),
}));
vi.mock('@/lib/api', () => ({ api: { post: postMock, get: getMock, delete: deleteMock } }));

import {
  AI_ATTACHMENT_MAX_BYTES,
  AI_ATTACHMENT_MAX_PER_MESSAGE,
  aiAttachmentDownloadUrl,
  attachmentMimeType,
  checkAttachment,
  deleteAiAttachment,
  uploadAiAttachment,
} from '../ai-attachments';
import { suggestionPageFor } from '../SuggestedPrompts';

function file(name: string, type: string, size = 10): File {
  const f = new File(['x'], name, { type });
  Object.defineProperty(f, 'size', { value: size });
  return f;
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

describe('ai-attachments', () => {
  it('accepts the allowlisted types and infers text types from the extension', () => {
    expect(attachmentMimeType(file('a.jpg', 'image/jpeg'))).toBe('image/jpeg');
    expect(attachmentMimeType(file('trace.jsonl', ''))).toBe('application/x-ndjson');
    expect(attachmentMimeType(file('ocpp.log', ''))).toBe('text/plain');
    expect(attachmentMimeType(file('data.csv', 'application/octet-stream'))).toBe('text/csv');
    expect(attachmentMimeType(file('page.html', 'text/html'))).toBeNull();
    expect(attachmentMimeType(file('evil.png', 'text/html'))).toBeNull();
    expect(attachmentMimeType(file('noext', ''))).toBeNull();
  });

  it('refuses a wrong type, an oversized file and too many files', () => {
    expect(checkAttachment(file('a.png', 'image/png'), 0)).toBeNull();
    expect(checkAttachment(file('a.exe', 'application/x-msdownload'), 0)).toBe('typeNotAllowed');
    expect(checkAttachment(file('a.png', 'image/png', AI_ATTACHMENT_MAX_BYTES + 1), 0)).toBe(
      'tooLarge',
    );
    expect(checkAttachment(file('a.png', 'image/png'), AI_ATTACHMENT_MAX_PER_MESSAGE)).toBe(
      'tooMany',
    );
  });

  it('uploads through the presigned POST and confirms', async () => {
    postMock
      .mockResolvedValueOnce({
        attachmentId: 'att1',
        uploadUrl: 'https://s3.example.com/bucket',
        fields: { key: 'ai-uploads/quarantine/x', policy: 'p' },
        expiresAt: '2026-10-10T00:05:00Z',
      })
      .mockResolvedValueOnce({
        id: 'att1',
        fileName: 'a.png',
        contentType: 'image/png',
        kind: 'image',
        sizeBytes: 10,
      });
    const fetchMock = vi.fn().mockResolvedValue(new Response(null, { status: 204 }));
    vi.stubGlobal('fetch', fetchMock);

    const stored = await uploadAiAttachment(file('trace.jsonl', ''));

    expect(postMock).toHaveBeenNthCalledWith(1, '/v1/assistant/attachments/upload-url', {
      fileName: 'trace.jsonl',
      contentType: 'application/x-ndjson',
      fileSize: 10,
    });
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('https://s3.example.com/bucket');
    expect(init.method).toBe('POST');
    const form = init.body as FormData;
    expect([...form.keys()]).toEqual(['key', 'policy', 'file']);
    expect(postMock).toHaveBeenNthCalledWith(2, '/v1/assistant/attachments/att1/confirm', {});
    expect(stored.id).toBe('att1');
  });

  it('throws when the storage refuses the upload and never confirms', async () => {
    postMock.mockResolvedValueOnce({
      attachmentId: 'att1',
      uploadUrl: 'https://s3.example.com',
      fields: {},
      expiresAt: '2026-10-10T00:05:00Z',
    });
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(null, { status: 403 })));
    await expect(uploadAiAttachment(file('a.png', 'image/png'))).rejects.toThrow();
    expect(postMock).toHaveBeenCalledTimes(1);
  });

  it('deletes and opens stored attachments by id', async () => {
    deleteMock.mockResolvedValue({ success: true });
    getMock.mockResolvedValue({ downloadUrl: 'https://s3.example.com/x?sig=1' });
    await deleteAiAttachment('att 1');
    expect(deleteMock).toHaveBeenCalledWith('/v1/assistant/attachments/att%201');
    expect(await aiAttachmentDownloadUrl('att1')).toBe('https://s3.example.com/x?sig=1');
    expect(getMock).toHaveBeenCalledWith('/v1/assistant/attachments/att1/download-url');
  });
});

describe('suggestionPageFor (TC-AI-UI-06)', () => {
  it('maps routes to their suggestion set', () => {
    expect(suggestionPageFor('/')).toBe('dashboard');
    expect(suggestionPageFor('/stations/CS-1')).toBe('stations');
    expect(suggestionPageFor('/support-cases/12')).toBe('supportCases');
    expect(suggestionPageFor('/tariffs')).toBe('pricing');
    expect(suggestionPageFor('/audit')).toBe('general');
  });
});
