// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { describe, it, expect, vi, beforeEach } from 'vitest';

// -- DB mock helpers --

let dbResults: unknown[][] = [];
let dbCallIndex = 0;

function setupDbResults(...results: unknown[][]) {
  dbResults = results;
  dbCallIndex = 0;
}

function makeChain() {
  const chain: Record<string, unknown> = {};
  const methods = [
    'select',
    'from',
    'where',
    'orderBy',
    'limit',
    'offset',
    'innerJoin',
    'leftJoin',
    'groupBy',
    'values',
    'returning',
    'set',
    'onConflictDoUpdate',
    'delete',
  ];
  for (const m of methods) {
    chain[m] = vi.fn(() => chain);
  }
  let awaited = false;
  chain['then'] = (onFulfilled?: (v: unknown) => unknown, onRejected?: (r: unknown) => unknown) => {
    if (!awaited) {
      awaited = true;
      const result = dbResults[dbCallIndex] ?? [];
      dbCallIndex++;
      return Promise.resolve(result).then(onFulfilled, onRejected);
    }
    return Promise.resolve([]).then(onFulfilled, onRejected);
  };
  chain['catch'] = (onRejected?: (r: unknown) => unknown) => Promise.resolve([]).catch(onRejected);
  return chain;
}

// -- Hoisted mocks --

const {
  mockDecryptString,
  mockGetSignedUrl,
  mockS3Send,
  mockS3ClientCtor,
  mockS3Destroy,
  mockCreatePresignedPost,
} = vi.hoisted(() => {
  return {
    mockS3Destroy: vi.fn(),
    mockCreatePresignedPost: vi.fn().mockResolvedValue({
      url: 'https://bucket.s3.example.com/',
      fields: { key: 'k', 'Content-Type': 'image/png', Policy: 'p' },
    }),
    mockS3ClientCtor: vi.fn(),
    mockDecryptString: vi.fn().mockReturnValue('decrypted-access-key'),
    mockGetSignedUrl: vi.fn().mockResolvedValue('https://s3.example.com/signed-url'),
    mockS3Send: vi.fn().mockResolvedValue({}),
  };
});

// -- Mocks --

vi.mock('@evtivity/database', () => ({
  db: {
    select: vi.fn(() => makeChain()),
  },
  settings: {},
}));

vi.mock('@evtivity/lib', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@evtivity/lib')>()),
  // Same contract as the real helper: an unset stored value is null.
  decryptSettingOrNull: (stored: unknown, passphrase: string) =>
    typeof stored === 'string' && stored !== ''
      ? (mockDecryptString(stored, passphrase) as string)
      : null,
}));

vi.mock('@aws-sdk/client-s3', () => {
  class MockS3Client {
    send = mockS3Send;
    destroy = mockS3Destroy;
    constructor(options: unknown) {
      mockS3ClientCtor(options);
    }
  }
  class MockPutObjectCommand {
    input: Record<string, unknown>;
    constructor(input: Record<string, unknown>) {
      this.input = input;
    }
  }
  class MockGetObjectCommand {
    input: Record<string, unknown>;
    constructor(input: Record<string, unknown>) {
      this.input = input;
    }
  }
  class MockDeleteObjectCommand {
    input: Record<string, unknown>;
    constructor(input: Record<string, unknown>) {
      this.input = input;
    }
  }
  class MockHeadObjectCommand {
    input: Record<string, unknown>;
    constructor(input: Record<string, unknown>) {
      this.input = input;
    }
  }
  class MockListObjectsV2Command {
    input: Record<string, unknown>;
    constructor(input: Record<string, unknown>) {
      this.input = input;
    }
  }
  class MockNoSuchKey extends Error {}
  class MockNotFound extends Error {}
  return {
    S3Client: MockS3Client,
    PutObjectCommand: MockPutObjectCommand,
    GetObjectCommand: MockGetObjectCommand,
    DeleteObjectCommand: MockDeleteObjectCommand,
    HeadObjectCommand: MockHeadObjectCommand,
    ListObjectsV2Command: MockListObjectsV2Command,
    NoSuchKey: MockNoSuchKey,
    NotFound: MockNotFound,
  };
});

vi.mock('@aws-sdk/s3-request-presigner', () => ({
  getSignedUrl: mockGetSignedUrl,
}));

vi.mock('@aws-sdk/s3-presigned-post', () => ({
  createPresignedPost: mockCreatePresignedPost,
}));

// -- Import under test (after mocks) --

import {
  clearObjectStorageCache,
  contentDispositionAttachment,
  loadObjectStorage,
  RETIRED_CLIENT_GRACE_MS,
  S3ObjectStorage,
} from '../storage/index.js';
import { NoSuchKey, NotFound } from '@aws-sdk/client-s3';
import type { S3Client } from '@aws-sdk/client-s3';
import { NodeHttpHandler } from '@smithy/node-http-handler';

const ENCRYPTION_KEY = 'test-encryption-key';

// -- Helpers --

function getStorage() {
  return loadObjectStorage(ENCRYPTION_KEY);
}

function settingsRows() {
  return [
    { key: 's3.bucket', value: 'my-bucket' },
    { key: 's3.region', value: 'us-east-1' },
    { key: 's3.accessKeyIdEnc', value: 'enc-access-key' },
    { key: 's3.secretAccessKeyEnc', value: 'enc-secret-key' },
  ];
}

function compatibleRows(overrides: Record<string, unknown> = {}) {
  const values: Record<string, unknown> = {
    's3.provider': 's3-compatible',
    's3.bucket': 'my-bucket',
    's3.region': 'us-east-1',
    's3.accessKeyIdEnc': 'enc-access-key',
    's3.secretAccessKeyEnc': 'enc-secret-key',
    's3.endpoint': 'https://storage.example.com',
    ...overrides,
  };
  return Object.entries(values).map(([key, value]) => ({ key, value }));
}

function makeStorage(): S3ObjectStorage {
  return new S3ObjectStorage({ send: mockS3Send } as unknown as S3Client, 'test-bucket');
}

// -- Tests --

describe('object storage', () => {
  beforeEach(() => {
    clearObjectStorageCache();
    setupDbResults();
    vi.clearAllMocks();
  });

  describe('loadObjectStorage', () => {
    it('returns null when required settings are missing', async () => {
      setupDbResults([]);
      const config = await getStorage();
      expect(config).toBeNull();
    });

    it('returns null when bucket is missing', async () => {
      setupDbResults([
        { key: 's3.region', value: 'us-east-1' },
        { key: 's3.accessKeyIdEnc', value: 'enc-access-key' },
        { key: 's3.secretAccessKeyEnc', value: 'enc-secret-key' },
      ]);
      const config = await getStorage();
      expect(config).toBeNull();
    });

    it('returns null when region is missing', async () => {
      setupDbResults([
        { key: 's3.bucket', value: 'my-bucket' },
        { key: 's3.accessKeyIdEnc', value: 'enc-access-key' },
        { key: 's3.secretAccessKeyEnc', value: 'enc-secret-key' },
      ]);
      const config = await getStorage();
      expect(config).toBeNull();
    });

    it.each([
      ['bucket', '', 'us-east-1'],
      ['region', 'my-bucket', ''],
    ])('returns null when the %s is an empty string', async (_field, bucket, region) => {
      setupDbResults([
        { key: 's3.bucket', value: bucket },
        { key: 's3.region', value: region },
      ]);
      const config = await getStorage();
      expect(config).toBeNull();
      expect(mockS3ClientCtor).not.toHaveBeenCalled();
    });

    it('returns null when accessKeyIdEnc is missing', async () => {
      setupDbResults([
        { key: 's3.bucket', value: 'my-bucket' },
        { key: 's3.region', value: 'us-east-1' },
        { key: 's3.secretAccessKeyEnc', value: 'enc-secret-key' },
      ]);
      const config = await getStorage();
      expect(config).toBeNull();
    });

    it('returns null when secretAccessKeyEnc is missing', async () => {
      setupDbResults([
        { key: 's3.bucket', value: 'my-bucket' },
        { key: 's3.region', value: 'us-east-1' },
        { key: 's3.accessKeyIdEnc', value: 'enc-access-key' },
      ]);
      const config = await getStorage();
      expect(config).toBeNull();
    });

    it('uses the default credential chain when no access keys are stored', async () => {
      setupDbResults([
        { key: 's3.bucket', value: 'my-bucket' },
        { key: 's3.region', value: 'us-east-1' },
      ]);
      const config = await getStorage();
      expect(config).not.toBeNull();
      expect(config!.bucket).toBe('my-bucket');
      expect(mockS3ClientCtor).toHaveBeenLastCalledWith({ region: 'us-east-1' });
      expect(mockDecryptString).not.toHaveBeenCalled();
    });

    it('returns config when all settings present', async () => {
      setupDbResults(settingsRows());
      const config = await getStorage();
      expect(config).not.toBeNull();
      expect(config!.provider).toBe('s3');
      expect(config!.bucket).toBe('my-bucket');
      expect(mockDecryptString).toHaveBeenCalledWith('enc-access-key', 'test-encryption-key');
      expect(mockDecryptString).toHaveBeenCalledWith('enc-secret-key', 'test-encryption-key');
    });

    it('filters out non-s3 settings', async () => {
      setupDbResults([
        ...settingsRows(),
        { key: 'smtp.host', value: 'mail.example.com' },
        { key: 'stripe.secretKeyEnc', value: 'should-be-ignored' },
      ]);
      const config = await getStorage();
      expect(config).not.toBeNull();
      expect(config!.bucket).toBe('my-bucket');
    });

    it('returns cached config on subsequent calls', async () => {
      setupDbResults(settingsRows());
      const first = await getStorage();
      expect(first).not.toBeNull();

      setupDbResults([]);
      const second = await getStorage();
      expect(second).toBe(first);
    });

    it('refetches after cache is cleared', async () => {
      setupDbResults(settingsRows());
      const first = await getStorage();
      expect(first).not.toBeNull();

      clearObjectStorageCache();
      setupDbResults([]);
      const second = await getStorage();
      expect(second).toBeNull();
    });

    it('uses the default credential chain when the stored keys are empty strings', async () => {
      setupDbResults([
        { key: 's3.bucket', value: 'my-bucket' },
        { key: 's3.region', value: 'us-east-1' },
        { key: 's3.accessKeyIdEnc', value: '' },
        { key: 's3.secretAccessKeyEnc', value: '' },
      ]);
      const config = await getStorage();
      expect(config).not.toBeNull();
      expect(config!.bucket).toBe('my-bucket');
      expect(mockS3ClientCtor).toHaveBeenLastCalledWith({ region: 'us-east-1' });
      expect(mockDecryptString).not.toHaveBeenCalled();
    });

    it('returns null when only one stored key is non-empty', async () => {
      setupDbResults([
        { key: 's3.bucket', value: 'my-bucket' },
        { key: 's3.region', value: 'us-east-1' },
        { key: 's3.accessKeyIdEnc', value: 'enc-access-key' },
        { key: 's3.secretAccessKeyEnc', value: '' },
      ]);
      const config = await getStorage();
      expect(config).toBeNull();
      expect(mockS3ClientCtor).not.toHaveBeenCalled();
    });

    it('throws when a stored key cannot be decrypted', async () => {
      mockDecryptString.mockImplementationOnce(() => {
        throw new Error('Invalid initialization vector');
      });
      setupDbResults(settingsRows());
      await expect(getStorage()).rejects.toThrow('Invalid initialization vector');
    });
  });

  describe('loadObjectStorage with an S3-compatible provider', () => {
    it('connects to the endpoint through the guarded request handler', async () => {
      setupDbResults(compatibleRows({ 's3.forcePathStyle': true }));
      const storage = await getStorage();
      expect(storage).not.toBeNull();
      expect(storage!.provider).toBe('s3-compatible');
      expect(storage!.bucket).toBe('my-bucket');
      expect(mockS3ClientCtor).toHaveBeenLastCalledWith({
        region: 'us-east-1',
        endpoint: 'https://storage.example.com',
        forcePathStyle: true,
        credentials: {
          accessKeyId: 'decrypted-access-key',
          secretAccessKey: 'decrypted-access-key',
        },
        requestHandler: expect.any(NodeHttpHandler),
      });
    });

    it('uses virtual-hosted requests unless path-style is on', async () => {
      setupDbResults(compatibleRows());
      await getStorage();
      expect(mockS3ClientCtor).toHaveBeenLastCalledWith(
        expect.objectContaining({ forcePathStyle: false }),
      );
    });

    it('needs access keys: the default credential chain only reaches AWS', async () => {
      setupDbResults(compatibleRows({ 's3.accessKeyIdEnc': '', 's3.secretAccessKeyEnc': '' }));
      await expect(getStorage()).resolves.toBeNull();
      expect(mockS3ClientCtor).not.toHaveBeenCalled();
    });

    it('stays off without an endpoint', async () => {
      setupDbResults(compatibleRows({ 's3.endpoint': '' }));
      await expect(getStorage()).resolves.toBeNull();
      expect(mockS3ClientCtor).not.toHaveBeenCalled();
    });

    it('refuses a private endpoint that is not on the allowlist', async () => {
      for (const endpoint of [
        'http://minio.internal:9000',
        'https://10.0.0.5:9000',
        'https://[::1]:9000',
        'https://localhost:9000',
      ]) {
        clearObjectStorageCache();
        setupDbResults(compatibleRows({ 's3.endpoint': endpoint }));
        await expect(getStorage(), endpoint).resolves.toBeNull();
      }
      expect(mockS3ClientCtor).not.toHaveBeenCalled();
    });

    it('accepts a private endpoint on the allowlist, also over plain http', async () => {
      setupDbResults(
        compatibleRows({
          's3.endpoint': 'http://minio.internal:9000',
          's3.allowedPrivateHosts': ['minio.internal'],
        }),
      );
      await expect(getStorage()).resolves.not.toBeNull();
      expect(mockS3ClientCtor).toHaveBeenLastCalledWith(
        expect.objectContaining({ endpoint: 'http://minio.internal:9000' }),
      );
    });

    it('stays off with an invalid allowlist', async () => {
      setupDbResults(compatibleRows({ 's3.allowedPrivateHosts': 'minio.internal' }));
      await expect(getStorage()).resolves.toBeNull();
    });

    it('stays off with a cloud metadata address, even on the allowlist (case 278)', async () => {
      for (const host of ['169.254.169.254', 'fd00:ec2::254']) {
        const literal = host.includes(':') ? `[${host}]` : host;
        setupDbResults(
          compatibleRows({
            's3.endpoint': `http://${literal}`,
            's3.allowedPrivateHosts': [host],
          }),
        );
        await expect(getStorage(), host).resolves.toBeNull();
        setupDbResults(compatibleRows({ 's3.allowedPrivateHosts': ['minio.internal', host] }));
        await expect(getStorage(), host).resolves.toBeNull();
      }
      expect(mockS3ClientCtor).not.toHaveBeenCalled();
    });

    it('stays off with an unknown provider', async () => {
      setupDbResults(compatibleRows({ 's3.provider': 'ftp' }));
      await expect(getStorage()).resolves.toBeNull();
    });

    it('ignores the endpoint settings for AWS S3', async () => {
      setupDbResults(compatibleRows({ 's3.provider': 's3' }));
      const storage = await getStorage();
      expect(storage!.provider).toBe('s3');
      expect(mockS3ClientCtor).toHaveBeenLastCalledWith({
        region: 'us-east-1',
        credentials: {
          accessKeyId: 'decrypted-access-key',
          secretAccessKey: 'decrypted-access-key',
        },
      });
    });
  });

  describe('clearObjectStorageCache', () => {
    it('clears the cached config', async () => {
      setupDbResults(settingsRows());
      const first = await getStorage();
      expect(first).not.toBeNull();

      clearObjectStorageCache();
      setupDbResults(settingsRows());
      const second = await getStorage();
      expect(second).not.toBe(first);
    });
  });

  describe('replaced clients', () => {
    it('destroys a cleared client after the grace period, not before', async () => {
      vi.useFakeTimers();
      try {
        setupDbResults(settingsRows());
        await getStorage();
        clearObjectStorageCache();
        vi.advanceTimersByTime(RETIRED_CLIENT_GRACE_MS - 1);
        expect(mockS3Destroy).not.toHaveBeenCalled();
        vi.advanceTimersByTime(1);
        expect(mockS3Destroy).toHaveBeenCalledTimes(1);
      } finally {
        vi.useRealTimers();
      }
    });

    it('destroys the client the 5-minute cache replaces', async () => {
      vi.useFakeTimers();
      try {
        setupDbResults(settingsRows());
        const first = await getStorage();
        vi.advanceTimersByTime(5 * 60 * 1000 + 1);
        setupDbResults(settingsRows());
        const second = await getStorage();
        expect(second).not.toBe(first);
        expect(mockS3ClientCtor).toHaveBeenCalledTimes(2);
        expect(mockS3Destroy).not.toHaveBeenCalled();
        vi.advanceTimersByTime(RETIRED_CLIENT_GRACE_MS);
        expect(mockS3Destroy).toHaveBeenCalledTimes(1);
      } finally {
        vi.useRealTimers();
      }
    });

    it('destroys nothing while the cached client is still served', async () => {
      vi.useFakeTimers();
      try {
        setupDbResults(settingsRows());
        await getStorage();
        await getStorage();
        vi.advanceTimersByTime(RETIRED_CLIENT_GRACE_MS * 2);
        expect(mockS3Destroy).not.toHaveBeenCalled();
      } finally {
        vi.useRealTimers();
      }
    });
  });

  describe('S3ObjectStorage.getDownloadUrl', () => {
    it('calls getSignedUrl with GetObjectCommand and correct params', async () => {
      const storage = makeStorage();
      const url = await storage.getDownloadUrl('download-bucket', 'files/doc.pdf');

      expect(mockGetSignedUrl).toHaveBeenCalledTimes(1);
      const [client, , options] = mockGetSignedUrl.mock.calls[0] as unknown[];
      expect(client).toBe(storage.client);
      expect((options as Record<string, unknown>).expiresIn).toBe(3600);
      expect(url).toBe('https://s3.example.com/signed-url');
    });

    it('serves inline only when asked, and as an attachment by default', async () => {
      const storage = makeStorage();
      await storage.getDownloadUrl('b', 'k', {
        fileName: 'front.jpg',
        contentType: 'image/jpeg',
        disposition: 'inline',
      });
      await storage.getDownloadUrl('b', 'k', {
        fileName: 'logo.svg',
        contentType: 'application/octet-stream',
      });
      const inputs = mockGetSignedUrl.mock.calls.map(
        (call) => (call[1] as { input: Record<string, string> }).input,
      );
      expect(inputs[0]).toMatchObject({
        ResponseContentType: 'image/jpeg',
        ResponseContentDisposition: expect.stringMatching(/^inline; filename="front.jpg"/),
      });
      expect(inputs[1]).toMatchObject({
        ResponseContentType: 'application/octet-stream',
        ResponseContentDisposition: expect.stringMatching(/^attachment; filename="logo.svg"/),
      });
    });
  });

  describe('S3ObjectStorage.deleteObject', () => {
    it('sends DeleteObjectCommand via s3 client', async () => {
      const storage = makeStorage();
      await storage.deleteObject('delete-bucket', 'files/old.pdf');

      expect(mockS3Send).toHaveBeenCalledTimes(1);
    });
  });

  describe('S3ObjectStorage.createUpload', () => {
    it('TC-AI-U-06 pins the key, the Content-Type and a 1..maxBytes length range', async () => {
      const storage = makeStorage();
      const post = await storage.createUpload('ai-uploads/quarantine/x/y.png', 'image/png', 1234);

      expect(post.method).toBe('POST');
      expect(post.url).toBe('https://bucket.s3.example.com/');
      const [client, options] = mockCreatePresignedPost.mock.calls[0] as [
        unknown,
        Record<string, unknown>,
      ];
      expect(client).toBe(storage.client);
      expect(options).toEqual({
        Bucket: 'test-bucket',
        Key: 'ai-uploads/quarantine/x/y.png',
        Conditions: [
          ['content-length-range', 1, 1234],
          ['eq', '$Content-Type', 'image/png'],
        ],
        Fields: { 'Content-Type': 'image/png' },
        Expires: 300,
      });
    });
  });

  describe('S3ObjectStorage.getDownloadUrl with options', () => {
    it('serves the file as an attachment with the given type', async () => {
      const storage = makeStorage();
      await storage.getDownloadUrl('b', 'k', {
        fileName: 'scan.pdf',
        contentType: 'application/pdf',
      });

      const [, command] = mockGetSignedUrl.mock.calls[0] as [
        unknown,
        { input: Record<string, unknown> },
      ];
      expect(command.input).toMatchObject({
        Bucket: 'b',
        Key: 'k',
        ResponseContentType: 'application/pdf',
        ResponseContentDisposition: contentDispositionAttachment('scan.pdf'),
      });
    });

    it('builds an RFC 6266 header with an ASCII fallback', () => {
      expect(contentDispositionAttachment('résumé "1".pdf')).toBe(
        'attachment; filename="r_sum_ _1_.pdf"; filename*=UTF-8\'\'r%C3%A9sum%C3%A9%20%221%22.pdf',
      );
    });
  });

  describe('S3ObjectStorage.testConnection', () => {
    it('lists at most one object of the configured bucket', async () => {
      const storage = makeStorage();
      await storage.testConnection();
      const [command] = mockS3Send.mock.calls[0] as [{ input: Record<string, unknown> }];
      expect(command.input).toEqual({ Bucket: 'test-bucket', MaxKeys: 1 });
    });

    it('rethrows the S3 error', async () => {
      mockS3Send.mockRejectedValueOnce(new Error('Access Denied'));
      await expect(makeStorage().testConnection()).rejects.toThrow('Access Denied');
    });
  });

  describe('S3ObjectStorage.readObject', () => {
    it('returns the bytes and stored type', async () => {
      const storage = makeStorage();
      mockS3Send.mockResolvedValueOnce({ ContentLength: 3 }).mockResolvedValueOnce({
        ContentType: 'text/plain',
        Body: { transformToByteArray: () => Promise.resolve(new Uint8Array([97, 98, 99])) },
      });
      const res = await storage.readObject('b', 'k', 10);
      expect(res).toEqual({ status: 'ok', bytes: Buffer.from('abc'), contentType: 'text/plain' });
    });

    it('refuses an object over the limit without downloading it', async () => {
      const storage = makeStorage();
      mockS3Send.mockResolvedValueOnce({ ContentLength: 11 });
      await expect(storage.readObject('b', 'k', 10)).resolves.toEqual({
        status: 'too_large',
        size: 11,
      });
      expect(mockS3Send).toHaveBeenCalledTimes(1);
    });

    it('reports a missing object', async () => {
      const storage = makeStorage();
      mockS3Send.mockRejectedValueOnce(new NotFound({ message: 'nf', $metadata: {} }));
      await expect(storage.readObject('b', 'k', 10)).resolves.toEqual({ status: 'missing' });
      mockS3Send
        .mockResolvedValueOnce({ ContentLength: 1 })
        .mockRejectedValueOnce(new NoSuchKey({ message: 'nsk', $metadata: {} }));
      await expect(storage.readObject('b', 'k', 10)).resolves.toEqual({ status: 'missing' });
    });

    it('rethrows other S3 errors', async () => {
      const storage = makeStorage();
      mockS3Send.mockRejectedValueOnce(new Error('AccessDenied'));
      await expect(storage.readObject('b', 'k', 10)).rejects.toThrow('AccessDenied');
    });
  });
});
