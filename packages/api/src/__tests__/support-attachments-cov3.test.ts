// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { AppError } from '@evtivity/lib';

const h = vi.hoisted(() => ({
  existing: [] as unknown[],
  storage: null as Record<string, unknown> | null,
  finalize: vi.fn(),
  insert: vi.fn(),
}));

vi.mock('@evtivity/database', () => {
  const c: Record<string, unknown> = {};
  for (const m of ['from', 'where']) c[m] = vi.fn(() => c);
  c['then'] = (resolve?: (v: unknown) => unknown) => Promise.resolve(h.existing).then(resolve);
  return {
    db: { select: vi.fn(() => c) },
    supportCaseAttachments: { messageId: 'messageId', s3Key: 's3Key' },
  };
});

vi.mock('@evtivity/services/support-case.service', () => ({
  insertSupportCaseAttachment: h.insert,
}));

vi.mock('../services/storage.service.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../services/storage.service.js')>()),
  getObjectStorage: vi.fn(async () => h.storage),
}));

vi.mock('../services/ai/attachments/upload-flow.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../services/ai/attachments/upload-flow.js')>()),
  attachmentLimits: vi.fn(async () => ({ maxBytes: 1000, maxPerMessage: 3 })),
  finalizeUpload: h.finalize,
}));

import {
  confirmSupportAttachment,
  requestSupportAttachmentUpload,
  supportAttachmentDownloadUrl,
} from '../services/ai/attachments/support-attachments.js';

const log = { warn: vi.fn() } as never;
const FILE_ID = '0123abcd-0123-4abc-8def-0123456789ab';
const KEY = `ai-uploads/quarantine/support-cases/cas_1/7/${FILE_ID}/photo.webp`;

async function code(p: Promise<unknown>): Promise<string | undefined> {
  try {
    await p;
    return undefined;
  } catch (err) {
    return err instanceof AppError ? err.code : String(err);
  }
}

beforeEach(() => {
  h.existing = [];
  h.storage = {
    bucket: 'b',
    createUpload: vi.fn(async () => ({
      method: 'PUT',
      url: 'https://r2/up',
      headers: { 'Content-Length': '10' },
    })),
    getDownloadUrl: vi.fn(async () => 'https://s3/dl'),
  };
});

describe('requestSupportAttachmentUpload', () => {
  it('issues an upload under the case and message quarantine prefix', async () => {
    const ticket = await requestSupportAttachmentUpload('cas_1', 7, {
      fileName: 'photo.png',
      contentType: 'image/png',
      fileSize: 10,
    });
    expect(ticket.uploadMethod).toBe('PUT');
    expect(ticket.uploadHeaders).toEqual({ 'Content-Length': '10' });
    expect(ticket.fields).toEqual({});
    expect(ticket.s3Key).toMatch(
      /^ai-uploads\/quarantine\/support-cases\/cas_1\/7\/[0-9a-f-]{36}\/photo\.png$/,
    );
    expect(h.storage?.['createUpload']).toHaveBeenCalledWith(ticket.s3Key, 'image/png', {
      size: 10,
      maxBytes: 1000,
    });
  });

  it('refuses a disallowed type and a missing storage', async () => {
    expect(
      await code(
        requestSupportAttachmentUpload('cas_1', 7, {
          fileName: 'a.exe',
          contentType: 'application/x-msdownload',
          fileSize: 10,
        }),
      ),
    ).toBe('AI_ATTACHMENT_TYPE_NOT_ALLOWED');
    h.storage = null;
    expect(
      await code(
        requestSupportAttachmentUpload('cas_1', 7, {
          fileName: 'a.png',
          contentType: 'image/png',
          fileSize: 10,
        }),
      ),
    ).toBe('STORAGE_NOT_CONFIGURED');
  });
});

describe('confirmSupportAttachment', () => {
  it('refuses keys of another case, message, outside quarantine or with an altered name', async () => {
    for (const key of [
      `ai-uploads/quarantine/support-cases/cas_2/7/${FILE_ID}/photo.webp`,
      `ai-uploads/quarantine/support-cases/cas_1/8/${FILE_ID}/photo.webp`,
      `support-cases/cas_1/7/${FILE_ID}/photo.webp`,
      `ai-uploads/quarantine/support-cases/cas_1/7/not-a-uuid/photo.webp`,
      `ai-uploads/quarantine/support-cases/cas_1/7/${FILE_ID}/../x`,
      `ai-uploads/quarantine/support-cases/cas_1/7/${FILE_ID}/.hidden`,
    ]) {
      expect(await code(confirmSupportAttachment('cas_1', 7, key, log))).toBe('VALIDATION_ERROR');
    }
    expect(h.finalize).not.toHaveBeenCalled();
  });

  it('returns the stored row for a second confirm', async () => {
    const row = { id: 1 };
    h.existing = [row];
    expect(await confirmSupportAttachment('cas_1', 7, KEY, log)).toEqual({
      attachment: row,
      created: false,
    });
    expect(h.finalize).not.toHaveBeenCalled();
  });

  it('processes the upload and records it with the new type extension', async () => {
    h.finalize.mockResolvedValueOnce({ contentType: 'image/jpeg', bytes: Buffer.alloc(9) });
    h.insert.mockResolvedValueOnce({ id: 2 });
    const out = await confirmSupportAttachment('cas_1', 7, KEY, log);
    expect(out).toEqual({ attachment: { id: 2 }, created: true });
    const cleanKey = `support-cases/cas_1/7/${FILE_ID}-photo.webp`;
    expect(h.finalize).toHaveBeenCalledWith(
      { storage: h.storage, quarantineKey: KEY, cleanKey, maxBytes: 1000 },
      log,
    );
    expect(h.insert).toHaveBeenCalledWith({
      messageId: 7,
      fileName: 'photo.jpg',
      fileSize: 9,
      contentType: 'image/jpeg',
      s3Key: cleanKey,
      s3Bucket: 'b',
    });
  });

  it('throws when the insert returns no row', async () => {
    h.finalize.mockResolvedValueOnce({ contentType: 'text/plain', bytes: Buffer.alloc(1) });
    h.insert.mockResolvedValueOnce(undefined);
    expect(await code(confirmSupportAttachment('cas_1', 7, KEY, log))).toBe(
      'Error: support attachment insert returned no row',
    );
  });

  it('answers STORAGE_NOT_CONFIGURED without storage', async () => {
    h.storage = null;
    expect(await code(confirmSupportAttachment('cas_1', 7, KEY, log))).toBe(
      'STORAGE_NOT_CONFIGURED',
    );
  });
});

describe('supportAttachmentDownloadUrl', () => {
  it('serves an allowlisted type as is and anything else as octet-stream', async () => {
    const base = { s3Bucket: 'b', s3Key: 'k', fileName: 'f' };
    expect(await supportAttachmentDownloadUrl({ ...base, contentType: 'image/png' })).toBe(
      'https://s3/dl',
    );
    await supportAttachmentDownloadUrl({ ...base, contentType: 'text/html' });
    const calls = (h.storage?.['getDownloadUrl'] as ReturnType<typeof vi.fn>).mock.calls;
    expect(calls).toEqual([
      ['b', 'k', { fileName: 'f', contentType: 'image/png' }],
      ['b', 'k', { fileName: 'f', contentType: 'application/octet-stream' }],
    ]);
  });
});
