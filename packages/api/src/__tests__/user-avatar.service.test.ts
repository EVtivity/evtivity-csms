// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { describe, it, expect, vi, beforeEach } from 'vitest';

// Each awaited query takes the next queued result.
let dbResults: unknown[] = [];
let dbCallIndex = 0;
type Chain = Record<string, ReturnType<typeof vi.fn>> & { then: unknown };
const updates: Chain[] = [];
function makeChain(kind: string): Chain {
  const chain = {} as Chain;
  for (const m of ['from', 'where', 'set', 'returning', 'for']) chain[m] = vi.fn(() => chain);
  chain.then = (resolve?: (v: unknown) => unknown, reject?: (r: unknown) => unknown) => {
    const r = dbResults[dbCallIndex] ?? [];
    dbCallIndex++;
    if (r instanceof Error) return Promise.reject(r).then(resolve, reject);
    return Promise.resolve(r).then(resolve, reject);
  };
  if (kind === 'update') updates.push(chain);
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
    users: {
      avatarKind: 'avatar_kind',
      avatarOptions: 'avatar_options',
      avatarS3Key: 'avatar_s3_key',
      avatarS3Bucket: 'avatar_s3_bucket',
      avatarUpdatedAt: 'avatar_updated_at',
      id: 'id',
    },
    userAuditLog: { name: 'user_audit_log' },
    writeAudit: vi.fn().mockResolvedValue(undefined),
  };
});

vi.mock('drizzle-orm', () => ({ eq: vi.fn() }));

const { s3Mock, deleteObjectMock, finalizeMock, uploadPostMock } = vi.hoisted(() => ({
  s3Mock: vi.fn(),
  deleteObjectMock: vi.fn(),
  finalizeMock: vi.fn(),
  uploadPostMock: vi.fn(),
}));
vi.mock('../services/storage.service.js', () => ({ getObjectStorage: s3Mock }));
vi.mock('../services/ai/attachments/upload-flow.js', () => ({ finalizeUpload: finalizeMock }));
const { enqueueDeleteMock, enqueuePurgeMock, purgeObjectsMock } = vi.hoisted(() => ({
  enqueueDeleteMock: vi.fn(),
  enqueuePurgeMock: vi.fn(),
  purgeObjectsMock: vi.fn(),
}));
vi.mock('@evtivity/lib/avatar-cleanup', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  enqueueUserAvatarObjectDelete: enqueueDeleteMock,
  enqueueUserAvatarPurge: enqueuePurgeMock,
}));
vi.mock('@evtivity/services/avatar-storage', () => ({
  purgeUserAvatarObjects: purgeObjectsMock,
}));

import { writeAudit } from '@evtivity/database';
import {
  confirmUserUploadedAvatar,
  purgeUserAvatarOnDelete,
  removeUserAvatar,
  setUserGeneratedAvatar,
} from '../services/user-avatar.service.js';
import { requestAvatarUpload } from '../services/account-avatar-upload.js';
import type { AuditActorInfo } from '../lib/audit-actor.js';
import type { ObjectStorage } from '../services/storage.service.js';
import type { FastifyBaseLogger } from 'fastify';

const USER_ID = 'usr_000000000001';
const actor: AuditActorInfo = {
  actor: 'operator',
  actorUserId: 'usr_000000000002',
  actorDriverId: null,
  actorApiKeyId: null,
  actorLabel: null,
};
const log = { warn: vi.fn(), info: vi.fn() } as unknown as FastifyBaseLogger;
const s3 = {
  bucket: 'avatars-bucket',
  deleteObject: deleteObjectMock,
  getDownloadUrl: vi.fn(),
  createUpload: uploadPostMock,
} as unknown as ObjectStorage;
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
  avatarS3Key: `avatars/users/${USER_ID}/old.jpg`,
  avatarS3Bucket: 'avatars-bucket',
  avatarUpdatedAt: new Date(),
};
const ctx = { actor, log, note: 'Avatar changed by an administrator' };

beforeEach(() => {
  dbResults = [];
  dbCallIndex = 0;
  updates.length = 0;
  vi.mocked(writeAudit).mockClear();
  s3Mock.mockReset().mockResolvedValue(s3);
  deleteObjectMock.mockReset().mockResolvedValue(undefined);
  finalizeMock.mockReset();
  uploadPostMock
    .mockReset()
    .mockResolvedValue({ method: 'POST', url: 'https://s3.test', fields: {} });
  enqueueDeleteMock.mockReset().mockResolvedValue(undefined);
  enqueuePurgeMock.mockReset().mockResolvedValue(undefined);
  purgeObjectsMock.mockReset().mockResolvedValue(0);
});

describe('setUserGeneratedAvatar', () => {
  it('refuses an option off the allow-list before any write', async () => {
    await expect(
      setUserGeneratedAvatar(USER_ID, { ...GENERATED, options: { topVariant: 'x' } }, ctx),
    ).rejects.toMatchObject({ statusCode: 400, code: 'VALIDATION_ERROR' });
    expect(updates).toHaveLength(0);
  });

  it('replaces an image, deletes it after the write and audits the kinds with the note', async () => {
    dbResults = [[IMAGE], [{ ...NONE, avatarKind: 'generated', avatarOptions: GENERATED }]];
    const result = await setUserGeneratedAvatar(USER_ID, GENERATED, ctx);
    expect(result.changed).toBe(true);
    expect(deleteObjectMock).toHaveBeenCalledWith('avatars-bucket', IMAGE.avatarS3Key);
    expect(writeAudit).toHaveBeenCalledWith(
      expect.objectContaining({ idColumn: 'user_id' }),
      expect.objectContaining({
        entityId: USER_ID,
        action: 'updated',
        before: { avatar: 'image' },
        after: { avatar: 'generated' },
        notes: 'Avatar changed by an administrator',
      }),
      expect.anything(),
      log,
    );
  });

  it('answers 404 USER_NOT_FOUND for an unknown user', async () => {
    dbResults = [[]];
    await expect(setUserGeneratedAvatar(USER_ID, GENERATED, ctx)).rejects.toMatchObject({
      statusCode: 404,
      code: 'USER_NOT_FOUND',
    });
  });
});

describe('confirmUserUploadedAvatar', () => {
  it('confirms a key only for the user it was issued to', async () => {
    const target = { kind: 'user', userId: USER_ID } as const;
    const ticket = await requestAvatarUpload(s3, target, 'image/jpeg');
    expect(ticket.s3Key).toMatch(
      new RegExp(`^ai-uploads/quarantine/avatars/users/${USER_ID}/[0-9a-f-]{36}/avatar$`),
    );
    const driverKey = `ai-uploads/quarantine/avatars/${USER_ID}/0b9a4c1e-2d3f-4a5b-8c7d-9e0f1a2b3c4d/avatar`;
    for (const [userId, key] of [
      ['usr_000000000009', ticket.s3Key],
      [USER_ID, driverKey],
      [USER_ID, `${ticket.s3Key}x`],
    ] as const) {
      await expect(
        confirmUserUploadedAvatar(userId, s3, { s3Key: key, s3Bucket: 'avatars-bucket' }, ctx),
      ).rejects.toMatchObject({ statusCode: 400, code: 'VALIDATION_ERROR' });
    }
    expect(finalizeMock).not.toHaveBeenCalled();

    finalizeMock.mockResolvedValue({ contentType: 'image/png' });
    dbResults = [[NONE], [NONE], [{ ...IMAGE }]];
    await confirmUserUploadedAvatar(
      USER_ID,
      s3,
      { s3Key: ticket.s3Key, s3Bucket: 'avatars-bucket' },
      ctx,
    );
    expect(finalizeMock).toHaveBeenCalledTimes(1);
    const set = updates[0]?.['set']?.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(set['avatarS3Key']).toMatch(
      new RegExp(`^avatars/users/${USER_ID}/[0-9a-f-]{36}\\.png$`),
    );
  });

  it('refuses another bucket', async () => {
    await expect(
      confirmUserUploadedAvatar(USER_ID, s3, { s3Key: 'x', s3Bucket: 'other' }, ctx),
    ).rejects.toMatchObject({ code: 'VALIDATION_ERROR' });
  });
});

describe('removeUserAvatar', () => {
  it('clears the row, deletes the image and is idempotent', async () => {
    dbResults = [[IMAGE], [NONE]];
    await expect(removeUserAvatar(USER_ID, ctx)).resolves.toBe(true);
    expect(deleteObjectMock).toHaveBeenCalledTimes(1);
    dbResults = [[NONE]];
    dbCallIndex = 0;
    vi.mocked(writeAudit).mockClear();
    await expect(removeUserAvatar(USER_ID, ctx)).resolves.toBe(false);
    expect(writeAudit).not.toHaveBeenCalled();
  });

  it('queues the delete when storage fails', async () => {
    deleteObjectMock.mockRejectedValue(new Error('s3 down'));
    dbResults = [[IMAGE], [NONE]];
    await removeUserAvatar(USER_ID, ctx);
    expect(enqueueDeleteMock).toHaveBeenCalledWith({
      userId: USER_ID,
      bucket: 'avatars-bucket',
      key: IMAGE.avatarS3Key,
    });
  });
});

describe('purgeUserAvatarOnDelete', () => {
  it('clears the avatar and purges every object of the user', async () => {
    dbResults = [[IMAGE], [IMAGE], [NONE]];
    await purgeUserAvatarOnDelete(USER_ID, ctx);
    expect(purgeObjectsMock).toHaveBeenCalledWith(s3, USER_ID, ['avatars-bucket']);
    expect(enqueuePurgeMock).not.toHaveBeenCalled();
  });

  it('queues the purge when storage fails, and never throws', async () => {
    purgeObjectsMock.mockRejectedValue(new Error('s3 down'));
    dbResults = [new Error('db down')];
    await expect(purgeUserAvatarOnDelete(USER_ID, ctx)).resolves.toBeUndefined();
    expect(enqueuePurgeMock).toHaveBeenCalledWith({ userId: USER_ID, buckets: [] });
  });
});
