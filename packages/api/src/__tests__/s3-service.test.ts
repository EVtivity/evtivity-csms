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

const { mockDecryptString, mockGetSignedUrl, mockS3Send, mockS3ClientCtor } = vi.hoisted(() => {
  return {
    mockS3ClientCtor: vi.fn(),
    mockDecryptString: vi.fn().mockReturnValue('decrypted-access-key'),
    mockGetSignedUrl: vi.fn().mockResolvedValue('https://s3.example.com/signed-url'),
    mockS3Send: vi.fn().mockResolvedValue({}),
  };
});

// -- Config mock --

const mockConfig = vi.hoisted(() => ({
  SETTINGS_ENCRYPTION_KEY: 'test-encryption-key',
  COOKIE_DOMAIN: undefined as string | undefined,
}));

vi.mock('../lib/config.js', () => ({
  config: mockConfig,
}));

// -- Mocks --

vi.mock('@evtivity/database', () => ({
  db: {
    select: vi.fn(() => makeChain()),
  },
  settings: {},
}));

vi.mock('@evtivity/lib', () => ({
  // Same contract as the real helper: an unset stored value is null.
  decryptSettingOrNull: (stored: unknown, passphrase: string) =>
    typeof stored === 'string' && stored !== ''
      ? (mockDecryptString(stored, passphrase) as string)
      : null,
}));

vi.mock('@aws-sdk/client-s3', () => {
  class MockS3Client {
    send = mockS3Send;
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
  return {
    S3Client: MockS3Client,
    PutObjectCommand: MockPutObjectCommand,
    GetObjectCommand: MockGetObjectCommand,
    DeleteObjectCommand: MockDeleteObjectCommand,
  };
});

vi.mock('@aws-sdk/s3-request-presigner', () => ({
  getSignedUrl: mockGetSignedUrl,
}));

// -- Import under test (after mocks) --

import {
  getS3Config,
  clearS3ConfigCache,
  generateUploadUrl,
  generateDownloadUrl,
  deleteObject,
  buildS3Key,
  buildStationImageS3Key,
} from '../services/s3.service.js';
import type { S3Config } from '../services/s3.service.js';

// -- Helpers --

function settingsRows() {
  return [
    { key: 's3.bucket', value: 'my-bucket' },
    { key: 's3.region', value: 'us-east-1' },
    { key: 's3.accessKeyIdEnc', value: 'enc-access-key' },
    { key: 's3.secretAccessKeyEnc', value: 'enc-secret-key' },
  ];
}

function makeMockS3Config(): S3Config {
  return {
    client: { send: mockS3Send } as unknown as S3Config['client'],
    bucket: 'test-bucket',
  };
}

// -- Tests --

describe('s3.service', () => {
  beforeEach(() => {
    mockConfig.SETTINGS_ENCRYPTION_KEY = 'test-encryption-key';
    clearS3ConfigCache();
    setupDbResults();
    vi.clearAllMocks();
  });

  describe('getS3Config', () => {
    it('returns null when required settings are missing', async () => {
      setupDbResults([]);
      const config = await getS3Config();
      expect(config).toBeNull();
    });

    it('returns null when bucket is missing', async () => {
      setupDbResults([
        { key: 's3.region', value: 'us-east-1' },
        { key: 's3.accessKeyIdEnc', value: 'enc-access-key' },
        { key: 's3.secretAccessKeyEnc', value: 'enc-secret-key' },
      ]);
      const config = await getS3Config();
      expect(config).toBeNull();
    });

    it('returns null when region is missing', async () => {
      setupDbResults([
        { key: 's3.bucket', value: 'my-bucket' },
        { key: 's3.accessKeyIdEnc', value: 'enc-access-key' },
        { key: 's3.secretAccessKeyEnc', value: 'enc-secret-key' },
      ]);
      const config = await getS3Config();
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
      const config = await getS3Config();
      expect(config).toBeNull();
      expect(mockS3ClientCtor).not.toHaveBeenCalled();
    });

    it('returns null when accessKeyIdEnc is missing', async () => {
      setupDbResults([
        { key: 's3.bucket', value: 'my-bucket' },
        { key: 's3.region', value: 'us-east-1' },
        { key: 's3.secretAccessKeyEnc', value: 'enc-secret-key' },
      ]);
      const config = await getS3Config();
      expect(config).toBeNull();
    });

    it('returns null when secretAccessKeyEnc is missing', async () => {
      setupDbResults([
        { key: 's3.bucket', value: 'my-bucket' },
        { key: 's3.region', value: 'us-east-1' },
        { key: 's3.accessKeyIdEnc', value: 'enc-access-key' },
      ]);
      const config = await getS3Config();
      expect(config).toBeNull();
    });

    it('uses the default credential chain when no access keys are stored', async () => {
      setupDbResults([
        { key: 's3.bucket', value: 'my-bucket' },
        { key: 's3.region', value: 'us-east-1' },
      ]);
      const config = await getS3Config();
      expect(config).not.toBeNull();
      expect(config!.bucket).toBe('my-bucket');
      expect(mockS3ClientCtor).toHaveBeenLastCalledWith({ region: 'us-east-1' });
      expect(mockDecryptString).not.toHaveBeenCalled();
    });

    it('returns config when all settings present', async () => {
      setupDbResults(settingsRows());
      const config = await getS3Config();
      expect(config).not.toBeNull();
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
      const config = await getS3Config();
      expect(config).not.toBeNull();
      expect(config!.bucket).toBe('my-bucket');
    });

    it('returns cached config on subsequent calls', async () => {
      setupDbResults(settingsRows());
      const first = await getS3Config();
      expect(first).not.toBeNull();

      setupDbResults([]);
      const second = await getS3Config();
      expect(second).toBe(first);
    });

    it('refetches after cache is cleared', async () => {
      setupDbResults(settingsRows());
      const first = await getS3Config();
      expect(first).not.toBeNull();

      clearS3ConfigCache();
      setupDbResults([]);
      const second = await getS3Config();
      expect(second).toBeNull();
    });

    it('uses the default credential chain when the stored keys are empty strings', async () => {
      setupDbResults([
        { key: 's3.bucket', value: 'my-bucket' },
        { key: 's3.region', value: 'us-east-1' },
        { key: 's3.accessKeyIdEnc', value: '' },
        { key: 's3.secretAccessKeyEnc', value: '' },
      ]);
      const config = await getS3Config();
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
      const config = await getS3Config();
      expect(config).toBeNull();
      expect(mockS3ClientCtor).not.toHaveBeenCalled();
    });

    it('throws when a stored key cannot be decrypted', async () => {
      mockDecryptString.mockImplementationOnce(() => {
        throw new Error('Invalid initialization vector');
      });
      setupDbResults(settingsRows());
      await expect(getS3Config()).rejects.toThrow('Invalid initialization vector');
    });
  });

  describe('clearS3ConfigCache', () => {
    it('clears the cached config', async () => {
      setupDbResults(settingsRows());
      const first = await getS3Config();
      expect(first).not.toBeNull();

      clearS3ConfigCache();
      setupDbResults(settingsRows());
      const second = await getS3Config();
      expect(second).not.toBe(first);
    });
  });

  describe('generateUploadUrl', () => {
    it('calls getSignedUrl with PutObjectCommand and correct params', async () => {
      const s3 = makeMockS3Config();
      const url = await generateUploadUrl(s3, 'uploads/test.pdf', 'application/pdf');

      expect(mockGetSignedUrl).toHaveBeenCalledTimes(1);
      const [client, command, options] = mockGetSignedUrl.mock.calls[0] as unknown[];
      expect(client).toBe(s3.client);
      expect(command).toBeDefined();
      expect((options as Record<string, unknown>).expiresIn).toBe(300);
      expect(url).toBe('https://s3.example.com/signed-url');
    });
  });

  describe('generateDownloadUrl', () => {
    it('calls getSignedUrl with GetObjectCommand and correct params', async () => {
      const s3 = makeMockS3Config();
      const url = await generateDownloadUrl(s3, 'download-bucket', 'files/doc.pdf');

      expect(mockGetSignedUrl).toHaveBeenCalledTimes(1);
      const [client, , options] = mockGetSignedUrl.mock.calls[0] as unknown[];
      expect(client).toBe(s3.client);
      expect((options as Record<string, unknown>).expiresIn).toBe(3600);
      expect(url).toBe('https://s3.example.com/signed-url');
    });
  });

  describe('deleteObject', () => {
    it('sends DeleteObjectCommand via s3 client', async () => {
      const s3 = makeMockS3Config();
      await deleteObject(s3, 'delete-bucket', 'files/old.pdf');

      expect(mockS3Send).toHaveBeenCalledTimes(1);
    });
  });

  describe('buildS3Key', () => {
    it('builds correct key path', () => {
      const key = buildS3Key('case-123', 'msg-456', 'file-789', 'document.pdf');
      expect(key).toBe('support-cases/case-123/msg-456/file-789-document.pdf');
    });

    it('handles special characters in fileName', () => {
      const key = buildS3Key('c1', 'm1', 'f1', 'my file (2).pdf');
      expect(key).toBe('support-cases/c1/m1/f1-my file (2).pdf');
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
      expect(key).toBe('stations/sta_2/img_2-.._.._etc_pa_ss_wd');
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
});
