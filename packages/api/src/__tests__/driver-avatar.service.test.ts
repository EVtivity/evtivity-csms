// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { describe, it, expect, vi, beforeEach } from 'vitest';

// Each awaited query takes the next queued result.
let dbResults: unknown[] = [];
let dbCallIndex = 0;
type Chain = Record<string, ReturnType<typeof vi.fn>> & { then: unknown };
const chains: { kind: string; chain: Chain }[] = [];
function makeChain(kind: string): Chain {
  const chain = {} as Chain;
  for (const m of ['from', 'where', 'set', 'returning', 'for']) chain[m] = vi.fn(() => chain);
  chain.then = (resolve?: (v: unknown) => unknown, reject?: (r: unknown) => unknown) => {
    const r = dbResults[dbCallIndex] ?? [];
    dbCallIndex++;
    if (r instanceof Error) return Promise.reject(r).then(resolve, reject);
    return Promise.resolve(r).then(resolve, reject);
  };
  chains.push({ kind, chain });
  return chain;
}

vi.mock('@evtivity/database', () => {
  const builders = {
    select: vi.fn(() => makeChain('select')),
    update: vi.fn(() => makeChain('update')),
  };
  return {
    db: {
      ...builders,
      transaction: vi.fn((fn: (tx: unknown) => Promise<unknown>) => fn(builders)),
    },
    drivers: {
      avatarKind: 'avatar_kind',
      avatarOptions: 'avatar_options',
      avatarS3Key: 'avatar_s3_key',
      avatarS3Bucket: 'avatar_s3_bucket',
      avatarUpdatedAt: 'avatar_updated_at',
      erasedAt: 'erased_at',
      id: 'id',
    },
    driverAuditLog: { name: 'driver_audit_log' },
    writeAudit: vi.fn().mockResolvedValue(undefined),
  };
});

vi.mock('drizzle-orm', () => ({ eq: vi.fn() }));

const { s3Mock, deleteObjectMock, downloadUrlMock, finalizeMock } = vi.hoisted(() => ({
  s3Mock: vi.fn(),
  deleteObjectMock: vi.fn(),
  downloadUrlMock: vi.fn(),
  finalizeMock: vi.fn(),
}));
vi.mock('../services/s3.service.js', () => ({
  getS3Config: s3Mock,
  deleteObject: deleteObjectMock,
  generateDownloadUrl: downloadUrlMock,
  QUARANTINE_PREFIX: 'ai-uploads/quarantine/',
  generateUploadPost: vi.fn(),
}));
vi.mock('../services/ai/attachments/upload-flow.js', () => ({ finalizeUpload: finalizeMock }));
const { enqueueDeleteMock, enqueuePurgeMock, purgeObjectsMock } = vi.hoisted(() => ({
  enqueueDeleteMock: vi.fn(),
  enqueuePurgeMock: vi.fn(),
  purgeObjectsMock: vi.fn(),
}));
vi.mock('@evtivity/lib/avatar-cleanup', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  enqueueDriverAvatarObjectDelete: enqueueDeleteMock,
  enqueueDriverAvatarPurge: enqueuePurgeMock,
}));
vi.mock('@evtivity/services/avatar-storage', () => ({
  purgeDriverAvatarObjects: purgeObjectsMock,
}));

import { writeAudit } from '@evtivity/database';
import {
  clearAvatarInErasure,
  confirmUploadedAvatar,
  purgeDriverAvatarStorage,
  removeAvatar,
  setGeneratedAvatar,
  writableAvatarRow,
} from '../services/driver-avatar.service.js';
import { AVATAR_CACHE_CONTROL, avatarView, withAvatars } from '../services/account-avatar.js';
import { requestAvatarUpload } from '../services/account-avatar-upload.js';
import type { AuditActorInfo } from '../lib/audit-actor.js';
import type { S3Config } from '../services/s3.service.js';
import type { FastifyBaseLogger } from 'fastify';

const DRIVER_ID = 'drv_000000000001';
const FILE_ID = '0b9a4c1e-2d3f-4a5b-8c7d-9e0f1a2b3c4d';
const QUARANTINE_KEY = `ai-uploads/quarantine/avatars/${DRIVER_ID}/${FILE_ID}/avatar`;
const actor: AuditActorInfo = {
  actor: 'driver',
  actorUserId: null,
  actorDriverId: DRIVER_ID,
  actorApiKeyId: null,
  actorLabel: null,
};
const log = { warn: vi.fn(), info: vi.fn() } as unknown as FastifyBaseLogger;
const s3 = { bucket: 'avatars-bucket' } as unknown as S3Config;
const NONE = {
  avatarKind: null,
  avatarOptions: null,
  avatarS3Key: null,
  avatarS3Bucket: null,
  avatarUpdatedAt: null,
};
const GENERATED = { style: 'avataaars', seed: 'abc', options: { topVariant: 'bob' } };
const IMAGE = {
  avatarKind: 'image',
  avatarOptions: null,
  avatarS3Key: `avatars/${DRIVER_ID}/old.jpg`,
  avatarS3Bucket: 'avatars-bucket',
  avatarUpdatedAt: new Date(),
};

function setCall(): Record<string, unknown> | undefined {
  return chains.find((c) => c.kind === 'update')?.chain['set']?.mock.calls[0]?.[0] as
    | Record<string, unknown>
    | undefined;
}

beforeEach(() => {
  dbResults = [];
  dbCallIndex = 0;
  chains.length = 0;
  vi.mocked(writeAudit).mockClear();
  s3Mock.mockReset().mockResolvedValue(s3);
  deleteObjectMock.mockReset().mockResolvedValue(undefined);
  downloadUrlMock.mockReset().mockResolvedValue('https://s3.example/avatar?sig=1');
  finalizeMock.mockReset();
  enqueueDeleteMock.mockReset().mockResolvedValue(undefined);
  enqueuePurgeMock.mockReset().mockResolvedValue(undefined);
  purgeObjectsMock.mockReset().mockResolvedValue(0);
  vi.mocked(log.warn).mockClear();
});

describe('setGeneratedAvatar', () => {
  it('refuses an option off the allow-list before any write', async () => {
    await expect(
      setGeneratedAvatar(DRIVER_ID, { ...GENERATED, options: { size: 9 } }, { actor, log }),
    ).rejects.toMatchObject({ statusCode: 400, code: 'VALIDATION_ERROR' });
    expect(chains).toHaveLength(0);
  });

  it('replaces an image, deletes the old object after the write and audits the kinds only', async () => {
    dbResults = [[{ ...IMAGE, erasedAt: null }], [{ ...NONE, avatarKind: 'generated' }]];
    await setGeneratedAvatar(DRIVER_ID, GENERATED, { actor, log });
    expect(setCall()).toMatchObject({
      avatarKind: 'generated',
      avatarOptions: GENERATED,
      avatarS3Key: null,
      avatarS3Bucket: null,
      avatarUpdatedAt: expect.any(Date),
    });
    expect(deleteObjectMock).toHaveBeenCalledWith(s3, 'avatars-bucket', IMAGE.avatarS3Key);
    expect(writeAudit).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        action: 'updated',
        before: { avatar: 'image' },
        after: { avatar: 'generated' },
      }),
      expect.anything(),
      log,
    );
  });

  it('queues the old object for the worker when its delete fails (L1)', async () => {
    dbResults = [[{ ...IMAGE, erasedAt: null }], [{ ...NONE, avatarKind: 'generated' }]];
    deleteObjectMock.mockRejectedValue(new Error('s3 down'));
    await expect(setGeneratedAvatar(DRIVER_ID, GENERATED, { actor, log })).resolves.toMatchObject({
      changed: true,
    });
    expect(log.warn).toHaveBeenCalled();
    expect(enqueueDeleteMock).toHaveBeenCalledWith({
      driverId: DRIVER_ID,
      bucket: 'avatars-bucket',
      key: IMAGE.avatarS3Key,
    });
  });

  it('queues the old object when S3 is not configured, and keeps going when the queue fails', async () => {
    dbResults = [[{ ...IMAGE, erasedAt: null }], [{ ...NONE, avatarKind: 'generated' }]];
    s3Mock.mockResolvedValue(null);
    enqueueDeleteMock.mockRejectedValue(new Error('redis down'));
    await expect(setGeneratedAvatar(DRIVER_ID, GENERATED, { actor, log })).resolves.toBeDefined();
    expect(deleteObjectMock).not.toHaveBeenCalled();
    expect(enqueueDeleteMock).toHaveBeenCalledTimes(1);
    expect(log.warn).toHaveBeenCalledWith(
      expect.anything(),
      'driver avatar object delete could not be queued',
    );
  });

  it('writes nothing when nothing changed, also with the options in another key order (L2)', async () => {
    const sent = {
      style: 'avataaars',
      seed: 'abc',
      options: { topVariant: 'bob', accessoriesProbability: 0, skinColor: '614335' },
    };
    const stored = {
      ...NONE,
      avatarKind: 'generated',
      // jsonb returns the keys in its own order
      avatarOptions: {
        seed: 'abc',
        style: 'avataaars',
        options: { skinColor: '614335', topVariant: 'bob', accessoriesProbability: 0 },
      },
    };
    dbResults = [[{ ...stored, erasedAt: null }]];
    const result = await setGeneratedAvatar(DRIVER_ID, sent, { actor, log });
    expect(result.changed).toBe(false);
    expect(chains.some((c) => c.kind === 'update')).toBe(false);
    expect(writeAudit).not.toHaveBeenCalled();
    expect(deleteObjectMock).not.toHaveBeenCalled();
  });

  it('answers 404 for an unknown driver and 409 for an erased one', async () => {
    dbResults = [[]];
    await expect(setGeneratedAvatar(DRIVER_ID, GENERATED, { actor, log })).rejects.toMatchObject({
      code: 'DRIVER_NOT_FOUND',
    });
    dbResults = [[{ ...NONE, erasedAt: new Date() }]];
    dbCallIndex = 0;
    await expect(setGeneratedAvatar(DRIVER_ID, GENERATED, { actor, log })).rejects.toMatchObject({
      code: 'DRIVER_ERASED',
    });
  });
});

describe('confirmUploadedAvatar', () => {
  it("refuses another driver's key without reading S3", async () => {
    await expect(
      confirmUploadedAvatar(
        DRIVER_ID,
        s3,
        {
          s3Key: `ai-uploads/quarantine/avatars/drv_other/${FILE_ID}/avatar`,
          s3Bucket: 'avatars-bucket',
        },
        { actor, log },
      ),
    ).rejects.toMatchObject({ statusCode: 400, code: 'VALIDATION_ERROR' });
    expect(finalizeMock).not.toHaveBeenCalled();
    expect(chains).toHaveLength(0);
  });

  it.each([
    ['a clean key', `avatars/${DRIVER_ID}/${FILE_ID}.jpg`],
    ['a path escape', `ai-uploads/quarantine/avatars/${DRIVER_ID}/../x/${FILE_ID}/avatar`],
    ['a station image key', `ai-uploads/quarantine/stations/${DRIVER_ID}/${FILE_ID}/avatar`],
  ])('refuses %s', async (_name, key) => {
    await expect(
      confirmUploadedAvatar(
        DRIVER_ID,
        s3,
        { s3Key: key, s3Bucket: 'avatars-bucket' },
        {
          actor,
          log,
        },
      ),
    ).rejects.toMatchObject({ code: 'VALIDATION_ERROR' });
  });

  it('refuses another bucket', async () => {
    await expect(
      confirmUploadedAvatar(
        DRIVER_ID,
        s3,
        { s3Key: QUARANTINE_KEY, s3Bucket: 'other' },
        {
          actor,
          log,
        },
      ),
    ).rejects.toMatchObject({ code: 'VALIDATION_ERROR' });
    expect(finalizeMock).not.toHaveBeenCalled();
  });

  it('stores the square re-encode, replaces the generated avatar and deletes nothing', async () => {
    finalizeMock.mockImplementation((input: { cleanKey: (t: string) => string }) => {
      input.cleanKey('image/jpeg');
      return Promise.resolve({ contentType: 'image/jpeg' });
    });
    const stored = {
      ...NONE,
      avatarKind: 'image',
      avatarS3Key: `avatars/${DRIVER_ID}/${FILE_ID}.jpg`,
      avatarS3Bucket: 'avatars-bucket',
    };
    dbResults = [
      [{ ...NONE, avatarKind: 'generated', avatarOptions: GENERATED }],
      [{ ...NONE, avatarKind: 'generated', avatarOptions: GENERATED, erasedAt: null }],
      [stored],
    ];
    const row = await confirmUploadedAvatar(
      DRIVER_ID,
      s3,
      { s3Key: QUARANTINE_KEY, s3Bucket: 'avatars-bucket' },
      { actor, log },
    );
    expect(row).toEqual(stored);
    expect(finalizeMock).toHaveBeenCalledWith(
      expect.objectContaining({
        quarantineKey: QUARANTINE_KEY,
        maxBytes: 1024 * 1024 - 1,
        image: { maxEdgePx: 512, square: true },
        acceptTypes: ['image/jpeg', 'image/png', 'image/webp'],
      }),
      log,
    );
    expect(setCall()).toMatchObject({
      avatarKind: 'image',
      avatarOptions: null,
      avatarS3Key: `avatars/${DRIVER_ID}/${FILE_ID}.jpg`,
    });
    expect(deleteObjectMock).not.toHaveBeenCalled();
  });

  it('names a PNG output by its type', async () => {
    finalizeMock.mockResolvedValue({ contentType: 'image/png' });
    dbResults = [[NONE], [{ ...NONE, erasedAt: null }], [NONE]];
    await confirmUploadedAvatar(
      DRIVER_ID,
      s3,
      { s3Key: QUARANTINE_KEY, s3Bucket: 'avatars-bucket' },
      { actor, log },
    );
    expect(setCall()?.['avatarS3Key']).toBe(`avatars/${DRIVER_ID}/${FILE_ID}.png`);
  });

  it('returns the current avatar for a retry of a confirmed key', async () => {
    const current = { ...IMAGE, avatarS3Key: `avatars/${DRIVER_ID}/${FILE_ID}.png` };
    dbResults = [[current]];
    await expect(
      confirmUploadedAvatar(
        DRIVER_ID,
        s3,
        { s3Key: QUARANTINE_KEY, s3Bucket: 'avatars-bucket' },
        { actor, log },
      ),
    ).resolves.toEqual(current);
    expect(finalizeMock).not.toHaveBeenCalled();
  });

  it("refuses a user avatar key, even one naming the driver's id", async () => {
    const { generateUploadPost } = await import('../services/s3.service.js');
    vi.mocked(generateUploadPost).mockResolvedValue({ url: 'https://s3.test', fields: {} });
    const ticket = await requestAvatarUpload(s3, { kind: 'user', userId: DRIVER_ID }, 'image/jpeg');
    expect(ticket.s3Key).toMatch(
      new RegExp(`^ai-uploads/quarantine/avatars/users/${DRIVER_ID}/[0-9a-f-]{36}/avatar$`),
    );
    await expect(
      confirmUploadedAvatar(
        DRIVER_ID,
        s3,
        { s3Key: ticket.s3Key, s3Bucket: 'avatars-bucket' },
        { actor, log },
      ),
    ).rejects.toMatchObject({ statusCode: 400, code: 'VALIDATION_ERROR' });
    expect(finalizeMock).not.toHaveBeenCalled();
  });

  it("binds an operator key to the driver and the operator: the driver's and another operator's keys are refused", async () => {
    const { generateUploadPost } = await import('../services/s3.service.js');
    vi.mocked(generateUploadPost).mockResolvedValue({ url: 'https://s3.test', fields: {} });
    const operatorA = { kind: 'operator', principal: 'user:usr_a' } as const;
    const operatorB = { kind: 'operator', principal: 'api_key:1' } as const;
    const ticket = await requestAvatarUpload(
      s3,
      { kind: 'driver', driverId: DRIVER_ID },
      'image/jpeg',
      operatorA,
    );
    expect(ticket.s3Key).toMatch(
      new RegExp(
        `^ai-uploads/quarantine/avatars/${DRIVER_ID}/op/[0-9a-f]{32}/[0-9a-f-]{36}/avatar$`,
      ),
    );
    const upload = { s3Key: ticket.s3Key, s3Bucket: 'avatars-bucket' };
    // The driver's own route and another operator refuse it without reading S3.
    for (const ctx of [
      { actor, log },
      { actor, log, uploader: operatorB },
    ]) {
      await expect(confirmUploadedAvatar(DRIVER_ID, s3, upload, ctx)).rejects.toMatchObject({
        statusCode: 400,
        code: 'VALIDATION_ERROR',
      });
    }
    // An operator refuses the driver's own key.
    await expect(
      confirmUploadedAvatar(
        DRIVER_ID,
        s3,
        { s3Key: QUARANTINE_KEY, s3Bucket: 'avatars-bucket' },
        { actor, log, uploader: operatorA },
      ),
    ).rejects.toMatchObject({ code: 'VALIDATION_ERROR' });
    expect(finalizeMock).not.toHaveBeenCalled();
  });

  it('refuses an erased driver before reading the upload', async () => {
    dbResults = [[{ ...NONE, erasedAt: new Date() }]];
    await expect(
      confirmUploadedAvatar(
        DRIVER_ID,
        s3,
        { s3Key: QUARANTINE_KEY, s3Bucket: 'avatars-bucket' },
        { actor, log },
      ),
    ).rejects.toMatchObject({ statusCode: 409, code: 'DRIVER_ERASED' });
    expect(finalizeMock).not.toHaveBeenCalled();
    dbResults = [[]];
    await expect(writableAvatarRow(DRIVER_ID)).rejects.toMatchObject({ statusCode: 404 });
  });

  it('deletes the new object when the row write fails', async () => {
    finalizeMock.mockResolvedValue({ contentType: 'image/jpeg' });
    dbResults = [[NONE], new Error('db down')];
    await expect(
      confirmUploadedAvatar(
        DRIVER_ID,
        s3,
        { s3Key: QUARANTINE_KEY, s3Bucket: 'avatars-bucket' },
        { actor, log },
      ),
    ).rejects.toThrow('db down');
    expect(deleteObjectMock).toHaveBeenCalledWith(
      s3,
      'avatars-bucket',
      `avatars/${DRIVER_ID}/${FILE_ID}.jpg`,
    );
  });
});

describe('removeAvatar', () => {
  it('clears the row and deletes the image', async () => {
    dbResults = [[{ ...IMAGE, erasedAt: null }], [NONE]];
    await removeAvatar(DRIVER_ID, { actor, log });
    expect(setCall()).toMatchObject({ avatarKind: null, avatarUpdatedAt: null });
    expect(deleteObjectMock).toHaveBeenCalledWith(s3, 'avatars-bucket', IMAGE.avatarS3Key);
    expect(writeAudit).toHaveBeenCalledTimes(1);
  });

  it('audits a removal with the note it is given', async () => {
    dbResults = [[{ ...IMAGE, erasedAt: null }], [NONE]];
    await expect(
      removeAvatar(DRIVER_ID, { actor, log, note: 'Avatar removed in a test' }),
    ).resolves.toBe(true);
    expect(writeAudit).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        before: { avatar: 'image' },
        after: { avatar: null },
        notes: 'Avatar removed in a test',
      }),
      expect.anything(),
      log,
    );
  });

  it('is idempotent without an avatar', async () => {
    dbResults = [[{ ...NONE, erasedAt: null }], [NONE]];
    await removeAvatar(DRIVER_ID, { actor, log });
    expect(writeAudit).not.toHaveBeenCalled();
    expect(deleteObjectMock).not.toHaveBeenCalled();
  });
});

describe('clearAvatarInErasure', () => {
  it('clears an image avatar and returns its object', async () => {
    dbResults = [[IMAGE], []];
    const builders = await import('@evtivity/database');
    const result = await clearAvatarInErasure(builders.db as never, DRIVER_ID);
    expect(result).toEqual({
      removed: true,
      object: { key: IMAGE.avatarS3Key, bucket: 'avatars-bucket' },
    });
    expect(setCall()).toMatchObject({ avatarKind: null, avatarS3Key: null });
  });

  it('writes nothing without an avatar', async () => {
    dbResults = [[NONE]];
    const builders = await import('@evtivity/database');
    expect(await clearAvatarInErasure(builders.db as never, DRIVER_ID)).toEqual({
      removed: false,
      object: null,
    });
    expect(chains.some((c) => c.kind === 'update')).toBe(false);
  });
});

describe('purgeDriverAvatarStorage', () => {
  it('deletes every object of the driver in the configured and the row bucket (L1)', async () => {
    purgeObjectsMock.mockResolvedValue(3);
    await expect(purgeDriverAvatarStorage(DRIVER_ID, 'old-bucket', log)).resolves.toBe(3);
    expect(purgeObjectsMock).toHaveBeenCalledWith(s3, DRIVER_ID, ['old-bucket']);
    expect(enqueuePurgeMock).not.toHaveBeenCalled();
  });

  it('queues the purge for the worker when storage fails', async () => {
    purgeObjectsMock.mockRejectedValue(new Error('s3 down'));
    await expect(purgeDriverAvatarStorage(DRIVER_ID, null, log)).resolves.toBe(0);
    expect(enqueuePurgeMock).toHaveBeenCalledWith({ driverId: DRIVER_ID, buckets: [] });
  });

  it('queues the purge without S3 only when the row named an image', async () => {
    s3Mock.mockResolvedValue(null);
    await purgeDriverAvatarStorage(DRIVER_ID, null, log);
    expect(enqueuePurgeMock).not.toHaveBeenCalled();
    await purgeDriverAvatarStorage(DRIVER_ID, 'avatars-bucket', log);
    expect(enqueuePurgeMock).toHaveBeenCalledWith({
      driverId: DRIVER_ID,
      buckets: ['avatars-bucket'],
    });
  });
});

describe('avatarView', () => {
  it('returns null, the generated options, or an inline presigned image', async () => {
    expect(await avatarView(NONE, s3)).toBeNull();
    expect(
      await avatarView({ ...NONE, avatarKind: 'generated', avatarOptions: GENERATED }, s3),
    ).toMatchObject({ kind: 'generated', ...GENERATED });
    const image = await avatarView(IMAGE, s3);
    expect(image).toMatchObject({ kind: 'image', url: 'https://s3.example/avatar?sig=1' });
    expect(downloadUrlMock).toHaveBeenCalledWith(s3, 'avatars-bucket', IMAGE.avatarS3Key, {
      fileName: 'avatar.jpg',
      contentType: 'image/jpeg',
      disposition: 'inline',
      cacheControl: 'private, no-store',
    });
    expect(AVATAR_CACHE_CONTROL).toBe('private, no-store');
  });

  it('gives a null URL when S3 is no longer configured', async () => {
    expect(await avatarView(IMAGE, null)).toMatchObject({ kind: 'image', url: null });
  });

  it('turns rows into replies without the raw columns', async () => {
    const [row] = await withAvatars([{ id: 'd1', ...IMAGE }]);
    expect(row).toEqual({ id: 'd1', avatar: expect.objectContaining({ kind: 'image' }) });
  });
});
