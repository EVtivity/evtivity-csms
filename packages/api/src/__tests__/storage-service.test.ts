// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { describe, it, expect, vi } from 'vitest';

const { mockLoadObjectStorage } = vi.hoisted(() => ({
  mockLoadObjectStorage: vi.fn(),
}));

vi.mock('../lib/config.js', () => ({
  config: { SETTINGS_ENCRYPTION_KEY: 'test-encryption-key' },
}));

vi.mock('@evtivity/services/storage', () => ({
  loadObjectStorage: mockLoadObjectStorage,
  clearObjectStorageCache: vi.fn(),
  UPLOAD_URL_EXPIRES_SECONDS: 300,
}));

import {
  getObjectStorage,
  buildS3Key,
  buildStationImageS3Key,
  buildSupportQuarantineKey,
  sanitizeFileName,
} from '../services/storage.service.js';

describe('storage.service', () => {
  describe('getObjectStorage', () => {
    it("loads the storage with this process's settings encryption key", async () => {
      const storage = { provider: 's3', bucket: 'b' };
      mockLoadObjectStorage.mockResolvedValueOnce(storage);
      await expect(getObjectStorage()).resolves.toBe(storage);
      expect(mockLoadObjectStorage).toHaveBeenCalledWith('test-encryption-key');
    });
  });

  // No unbounded presigned PUT helper exists, so no caller can bring back an
  // upload without a size limit.
  it('exports no presigned PUT upload URL', async () => {
    const mod = await import('../services/storage.service.js');
    expect(Object.keys(mod)).not.toContain('generateUploadUrl');
  });

  // Case 175 for the shared storage module: no export hands out an upload URL;
  // the only upload path is createUpload. AWS S3 and S3-compatible providers
  // upload through a size-bounded POST policy and presign GET (downloads)
  // only. Cloudflare R2 has no POST policy, so R2ObjectStorage alone may
  // presign a PUT, and only with Content-Length and Content-Type signed: R2
  // refuses a body of another size or type (r2-live.test.ts), so an unbounded
  // PUT URL cannot come back.
  it('@evtivity/services/storage presigns GET, and a PUT only for R2 with the length and type signed', async () => {
    const actual = await vi.importActual<Record<string, unknown>>('@evtivity/services/storage');
    for (const name of Object.keys(actual)) {
      expect(name).not.toMatch(/upload ?url|put ?url|presign/i);
    }
    const ownMethods = (cls: unknown): string[] =>
      Object.getOwnPropertyNames((cls as { prototype: object }).prototype)
        .filter((name) => name !== 'constructor')
        .sort();
    expect(ownMethods(actual['S3ObjectStorage'])).toEqual([
      'createUpload',
      'deleteObject',
      'deleteObjectsUnderPrefix',
      'getDownloadUrl',
      'putObject',
      'readObject',
      'testConnection',
    ]);
    // R2 changes the upload only; everything else is the S3 API.
    expect(ownMethods(actual['R2ObjectStorage'])).toEqual(['createUpload']);
    expect(actual['R2_SIGNED_UPLOAD_HEADERS']).toEqual(['content-length', 'content-type']);

    const { readFileSync, readdirSync } = await import('node:fs');
    const { fileURLToPath } = await import('node:url');
    const dir = fileURLToPath(new URL('../../../services/src/storage/', import.meta.url));
    let presignedGet = 0;
    let presignedPut = 0;
    for (const file of readdirSync(dir).filter((f) => f.endsWith('.ts'))) {
      const source = readFileSync(`${dir}${file}`, 'utf8');
      for (const call of source.matchAll(/getSignedUrl\(\s*this\.client,\s*(\w+)/g)) {
        const variable = call[1] ?? '';
        if (new RegExp(`const ${variable} = new GetObjectCommand\\(`).test(source)) {
          presignedGet++;
          continue;
        }
        expect(file, `${file}: ${variable} presigns neither a GET nor the R2 upload`).toBe(
          'r2-object-storage.ts',
        );
        expect(source).toMatch(new RegExp(`const ${variable} = new PutObjectCommand\\(`));
        expect(source).toMatch(/signableHeaders: new Set\(R2_SIGNED_UPLOAD_HEADERS\)/);
        presignedPut++;
      }
      expect(source, file).not.toMatch(/getSignedUrl\([^)]*PutObjectCommand/);
    }
    expect(presignedGet).toBeGreaterThan(0);
    expect(presignedPut).toBe(1);
    // importActual loads the real AWS SDK clients, which takes close to the
    // 5 s default on a cold run.
  }, 30_000);

  it('signs an R2 upload for exactly the declared size and type, never over maxBytes', async () => {
    const { S3Client } =
      await vi.importActual<typeof import('@aws-sdk/client-s3')>('@aws-sdk/client-s3');
    const { R2ObjectStorage } = await vi.importActual<typeof import('@evtivity/services/storage')>(
      '@evtivity/services/storage',
    );
    const client = new S3Client({
      region: 'auto',
      endpoint: 'https://0123456789abcdef0123456789abcdef.r2.cloudflarestorage.com',
      forcePathStyle: true,
      credentials: { accessKeyId: 'AKIDEXAMPLE', secretAccessKey: 'secret' },
      requestChecksumCalculation: 'WHEN_REQUIRED',
    });
    const storage = new R2ObjectStorage(client, 'files');
    const target = await storage.createUpload('ai-uploads/quarantine/x/y.png', 'image/png', {
      size: 2048,
      maxBytes: 4096,
    });
    if (target.method !== 'PUT') throw new Error('R2 uploads with a PUT');
    const url = new URL(target.url);
    expect(url.searchParams.get('X-Amz-SignedHeaders')).toBe('content-length;content-type;host');
    expect([...url.searchParams.keys()].filter((key) => /checksum/i.test(key))).toEqual([]);
    expect(target.headers).toEqual({ 'Content-Type': 'image/png' });

    for (const size of [0, 4097, 1.5]) {
      await expect(
        storage.createUpload('k', 'image/png', { size, maxBytes: 4096 }),
        String(size),
      ).rejects.toThrow(RangeError);
    }
    client.destroy();
  }, 30_000);

  describe('buildS3Key', () => {
    it('builds correct key path', () => {
      const key = buildS3Key('case-123', 'msg-456', 'file-789', 'document.pdf');
      expect(key).toBe('support-cases/case-123/msg-456/file-789-document.pdf');
    });

    it('TC-AI-U-16 sanitizes the file name in the key', () => {
      const key = buildS3Key('c1', 'm1', 'f1', 'my file (2).pdf');
      expect(key).toBe('support-cases/c1/m1/f1-my_file__2_.pdf');
    });

    it('TC-AI-U-16 strips path traversal from the file name', () => {
      const key = buildS3Key('c1', 'm1', 'f1', '../../other-case/x.png');
      expect(key).toBe('support-cases/c1/m1/f1-_.._other-case_x.png');
      expect(key.split('/')).toHaveLength(4);
    });

    it('accepts a numeric messageId', () => {
      const key = buildS3Key('case-1', 42, 'file-9', 'doc.pdf');
      expect(key).toBe('support-cases/case-1/42/file-9-doc.pdf');
    });
  });

  describe('buildStationImageS3Key', () => {
    it('builds the station image key with a sanitized fileName', () => {
      const key = buildStationImageS3Key('sta_1', 'img_1', 'photo.png');
      expect(key).toBe('stations/sta_1/img_1-photo.png');
    });

    it('replaces path separators and unsafe characters with underscores', () => {
      // Dots, hyphens and underscores are preserved; slashes and spaces are not.
      const key = buildStationImageS3Key('sta_2', 'img_2', '../../etc/pa ss?wd');
      expect(key).toBe('stations/sta_2/img_2-_.._etc_pa_ss_wd');
    });

    it('truncates long file names to 100 characters', () => {
      const longName = 'a'.repeat(150) + '.png';
      const key = buildStationImageS3Key('sta_3', 'img_3', longName);
      const fileNamePart = key.split('img_3-')[1] as string;
      expect(fileNamePart).toHaveLength(100);
    });

    it('falls back to "image" when the sanitized fileName is empty', () => {
      const key = buildStationImageS3Key('sta_4', 'img_4', '@@@');
      // '@@@' sanitizes to '___' (non-empty), so use a name that empties out.
      expect(key).toBe('stations/sta_4/img_4-___');
    });

    it('uses the "image" fallback for an empty fileName', () => {
      const key = buildStationImageS3Key('sta_5', 'img_5', '');
      expect(key).toBe('stations/sta_5/img_5-image');
    });
  });

  describe('sanitizeFileName', () => {
    it('TC-AI-U-16 keeps safe characters, drops leading dots, caps at 100', () => {
      expect(sanitizeFileName('report.final-v2_ok.pdf')).toBe('report.final-v2_ok.pdf');
      expect(sanitizeFileName('.htaccess')).toBe('htaccess');
      expect(sanitizeFileName('a'.repeat(200))).toHaveLength(100);
      expect(sanitizeFileName('')).toBe('file');
      expect(sanitizeFileName('...', 'image')).toBe('image');
    });
  });

  describe('buildSupportQuarantineKey', () => {
    it('puts uploads under the quarantine prefix with a sanitized name', () => {
      expect(buildSupportQuarantineKey('sc_1', 7, 'uuid-1', 'a b.png')).toBe(
        'ai-uploads/quarantine/support-cases/sc_1/7/uuid-1/a_b.png',
      );
    });
  });
});
