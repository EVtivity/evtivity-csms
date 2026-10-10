// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { describe, it, expect, vi, beforeEach } from 'vitest';
import sharp from 'sharp';
import type { FastifyBaseLogger } from 'fastify';

const mocks = vi.hoisted(() => ({
  readObject: vi.fn(),
  putObject: vi.fn(),
  deleteObject: vi.fn(),
}));

vi.mock('@evtivity/database', () => ({ getAiSettings: vi.fn() }));

vi.mock('../services/s3.service.js', () => ({
  readObject: mocks.readObject,
  putObject: mocks.putObject,
  deleteObject: mocks.deleteObject,
}));

import {
  checkUploadRequest,
  displayFileName,
  finalizeUpload,
} from '../services/ai/attachments/upload-flow.js';
import {
  ALLOWED_ATTACHMENT_MIMES,
  maxPdfPagesAcrossModels,
  resolveDeclaredType,
} from '../services/ai/attachments/allowlist.js';
import type { S3Config } from '../services/s3.service.js';

const S3 = { bucket: 'bkt', client: {} } as unknown as S3Config;
const log = { warn: vi.fn(), info: vi.fn() } as unknown as FastifyBaseLogger;
const QUARANTINE = 'ai-uploads/quarantine/chat/usr_1/u1/photo.png';
const CLEAN = 'ai-uploads/chat/usr_1/u1-photo.png';

async function png(): Promise<Buffer> {
  return sharp({ create: { width: 10, height: 10, channels: 3, background: '#000' } })
    .png()
    .toBuffer();
}

beforeEach(() => {
  mocks.readObject.mockReset();
  mocks.putObject.mockReset().mockResolvedValue(undefined);
  mocks.deleteObject.mockReset().mockResolvedValue(undefined);
  vi.mocked(log.warn).mockClear();
});

describe('resolveDeclaredType', () => {
  it('accepts allowlisted types and drops parameters', () => {
    expect(resolveDeclaredType('a.png', 'image/png')).toBe('image/png');
    expect(resolveDeclaredType('a.csv', 'text/csv; charset=utf-8')).toBe('text/csv');
    expect(resolveDeclaredType('a.jpg', 'IMAGE/JPG')).toBe('image/jpeg');
  });

  it('falls back to the extension when the browser gives no type', () => {
    expect(resolveDeclaredType('ocpp.log', '')).toBe('text/plain');
    expect(resolveDeclaredType('trace.jsonl', 'application/octet-stream')).toBe(
      'application/x-ndjson',
    );
    expect(resolveDeclaredType('blob', '')).toBeNull();
  });

  it('refuses types off the allowlist, whatever the extension', () => {
    expect(resolveDeclaredType('page.html', 'text/html')).toBeNull();
    expect(resolveDeclaredType('a.png', 'image/svg+xml')).toBeNull();
    expect(resolveDeclaredType('a.exe', 'application/octet-stream')).toBeNull();
    expect(resolveDeclaredType('a.png', 'application/x-msdownload')).toBeNull();
  });

  it('allows exactly the planned types', () => {
    expect([...ALLOWED_ATTACHMENT_MIMES].sort()).toEqual(
      [
        'application/json',
        'application/pdf',
        'application/x-ndjson',
        'image/gif',
        'image/jpeg',
        'image/png',
        'image/webp',
        'text/csv',
        'text/plain',
      ].sort(),
    );
  });

  it('takes the PDF page cap from the model registry', () => {
    // The highest page limit of any listed model (Gemini, 1000 pages).
    expect(maxPdfPagesAcrossModels()).toBe(1000);
  });
});

describe('checkUploadRequest', () => {
  it('refuses a type off the allowlist', () => {
    expect(() => checkUploadRequest('x.html', 'text/html', 10, 100)).toThrow(
      expect.objectContaining({ code: 'AI_ATTACHMENT_TYPE_NOT_ALLOWED', statusCode: 400 }),
    );
  });

  it('refuses a declared size over the limit', () => {
    expect(() => checkUploadRequest('x.png', 'image/png', 101, 100)).toThrow(
      expect.objectContaining({ code: 'AI_ATTACHMENT_TOO_LARGE', statusCode: 400 }),
    );
  });

  it('returns the resolved type', () => {
    expect(checkUploadRequest('x.log', '', 100, 100)).toBe('text/plain');
  });
});

describe('finalizeUpload', () => {
  it('TC-AI-U-12 writes the clean file and deletes the quarantine object', async () => {
    mocks.readObject.mockResolvedValue({
      status: 'ok',
      bytes: await png(),
      contentType: 'image/png',
    });
    const res = await finalizeUpload(
      {
        s3: S3,
        quarantineKey: QUARANTINE,
        cleanKey: CLEAN,
        declaredType: 'image/png',
        maxBytes: 1000,
      },
      log,
    );
    expect(res.contentType).toBe('image/jpeg');
    expect(mocks.readObject).toHaveBeenCalledWith(S3, 'bkt', QUARANTINE, 1000);
    expect(mocks.putObject).toHaveBeenCalledWith(S3, 'bkt', CLEAN, res.bytes, 'image/jpeg');
    expect(mocks.deleteObject).toHaveBeenCalledWith(S3, 'bkt', QUARANTINE);
  });

  it('TC-AI-U-12 deletes the quarantine object of a refused upload', async () => {
    mocks.readObject.mockResolvedValue({
      status: 'ok',
      bytes: Buffer.from('<html></html>'),
      contentType: 'image/png',
    });
    await expect(
      finalizeUpload(
        {
          s3: S3,
          quarantineKey: QUARANTINE,
          cleanKey: CLEAN,
          declaredType: 'image/png',
          maxBytes: 1000,
        },
        log,
      ),
    ).rejects.toMatchObject({ code: 'AI_ATTACHMENT_REJECTED' });
    expect(mocks.putObject).not.toHaveBeenCalled();
    expect(mocks.deleteObject).toHaveBeenCalledWith(S3, 'bkt', QUARANTINE);
  });

  it('refuses when nothing was uploaded', async () => {
    mocks.readObject.mockResolvedValue({ status: 'missing' });
    await expect(
      finalizeUpload({ s3: S3, quarantineKey: QUARANTINE, cleanKey: CLEAN, maxBytes: 1000 }, log),
    ).rejects.toMatchObject({ code: 'AI_ATTACHMENT_REJECTED' });
  });

  it('TC-AI-U-06 refuses an object over the limit', async () => {
    mocks.readObject.mockResolvedValue({ status: 'too_large', size: 5000 });
    await expect(
      finalizeUpload({ s3: S3, quarantineKey: QUARANTINE, cleanKey: CLEAN, maxBytes: 1000 }, log),
    ).rejects.toMatchObject({ code: 'AI_ATTACHMENT_TOO_LARGE' });
    expect(mocks.deleteObject).toHaveBeenCalledWith(S3, 'bkt', QUARANTINE);
  });

  it('refuses a stored type that differs from the issued one', async () => {
    mocks.readObject.mockResolvedValue({
      status: 'ok',
      bytes: await png(),
      contentType: 'text/html',
    });
    await expect(
      finalizeUpload(
        {
          s3: S3,
          quarantineKey: QUARANTINE,
          cleanKey: CLEAN,
          declaredType: 'image/png',
          maxBytes: 1000,
        },
        log,
      ),
    ).rejects.toMatchObject({ code: 'AI_ATTACHMENT_REJECTED' });
  });

  it('without a declared type, requires an allowlisted stored type', async () => {
    mocks.readObject.mockResolvedValue({
      status: 'ok',
      bytes: Buffer.from('<p>'),
      contentType: 'text/html',
    });
    await expect(
      finalizeUpload({ s3: S3, quarantineKey: QUARANTINE, cleanKey: CLEAN, maxBytes: 1000 }, log),
    ).rejects.toMatchObject({ code: 'AI_ATTACHMENT_REJECTED' });

    mocks.readObject.mockResolvedValue({
      status: 'ok',
      bytes: Buffer.from('a,b\n'),
      contentType: 'text/csv',
    });
    await expect(
      finalizeUpload({ s3: S3, quarantineKey: QUARANTINE, cleanKey: CLEAN, maxBytes: 1000 }, log),
    ).resolves.toMatchObject({ contentType: 'text/csv' });
  });

  it('succeeds and warns when the quarantine delete fails (lifecycle rule cleans up)', async () => {
    mocks.readObject.mockResolvedValue({
      status: 'ok',
      bytes: Buffer.from('a'),
      contentType: 'text/plain',
    });
    mocks.deleteObject.mockRejectedValue(new Error('AccessDenied'));
    await expect(
      finalizeUpload({ s3: S3, quarantineKey: QUARANTINE, cleanKey: CLEAN, maxBytes: 1000 }, log),
    ).resolves.toMatchObject({ contentType: 'text/plain' });
    expect(log.warn).toHaveBeenCalled();
  });
});

describe('displayFileName', () => {
  it('gives a re-encoded image the extension of its new type', () => {
    expect(displayFileName('photo.webp', 'image/jpeg')).toBe('photo.jpg');
    expect(displayFileName('anim.gif', 'image/png')).toBe('anim.png');
    expect(displayFileName('noext', 'image/png')).toBe('noext.png');
    expect(displayFileName('trace.jsonl', 'application/x-ndjson')).toBe('trace.jsonl');
  });
});
