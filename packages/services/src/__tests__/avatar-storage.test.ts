// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  DeleteObjectCommand,
  DeleteObjectsCommand,
  ListObjectsV2Command,
} from '@aws-sdk/client-s3';

let dbRows: unknown[][] = [];
vi.mock('@evtivity/database', () => {
  const chain: Record<string, unknown> = {};
  for (const m of ['select', 'from', 'where']) chain[m] = vi.fn(() => chain);
  chain['then'] = (resolve: (v: unknown) => unknown) =>
    Promise.resolve(dbRows.shift() ?? []).then(resolve);
  return {
    db: chain,
    drivers: { id: 'id', erasedAt: 'erased_at', avatarS3Key: 'k', avatarS3Bucket: 'b' },
    users: { id: 'id', isActive: 'a', avatarKind: 'ak', avatarS3Key: 'k', avatarS3Bucket: 'b' },
  };
});
vi.mock('drizzle-orm', () => ({ eq: vi.fn(), and: vi.fn() }));

import {
  purgeDriverAvatarObjects,
  purgeUserAvatarObjects,
  runAvatarCleanupJob,
} from '../avatar-storage.js';
import { S3ObjectStorage } from '../storage/s3-object-storage.js';
import type { S3Client } from '@aws-sdk/client-s3';

/** An S3 client over an in-memory bucket map, listing pages of `pageSize` keys. */
function fakeS3(objects: Record<string, string[]>, pageSize = 1000) {
  const sent: unknown[] = [];
  const send = vi.fn(async (command: unknown): Promise<unknown> => {
    sent.push(command);
    if (command instanceof ListObjectsV2Command) {
      const { Bucket, Prefix, ContinuationToken } = command.input;
      // Like S3, the token resumes after the last key listed, so deletes in between do not skip keys.
      const keys = (objects[Bucket as string] ?? [])
        .filter((k) => k.startsWith(Prefix as string))
        .filter((k) => ContinuationToken == null || k > ContinuationToken)
        .sort();
      const page = keys.slice(0, pageSize);
      const next = keys.length > pageSize ? page[page.length - 1] : undefined;
      return {
        Contents: page.map((Key) => ({ Key })),
        IsTruncated: next != null,
        NextContinuationToken: next,
      };
    }
    if (command instanceof DeleteObjectsCommand) {
      const bucket = command.input.Bucket as string;
      const gone = new Set((command.input.Delete?.Objects ?? []).map((o) => o.Key));
      objects[bucket] = (objects[bucket] ?? []).filter((k) => !gone.has(k));
      return { Errors: [] };
    }
    if (command instanceof DeleteObjectCommand) {
      const bucket = command.input.Bucket as string;
      objects[bucket] = (objects[bucket] ?? []).filter((k) => k !== command.input.Key);
      return {};
    }
    throw new Error('unexpected command');
  });
  return { storage: new S3ObjectStorage({ send } as unknown as S3Client, 'main'), sent, send };
}

const log = { warn: vi.fn(), info: vi.fn() };
const DRIVER = 'drv_1';

beforeEach(() => {
  dbRows = [];
  log.warn.mockClear();
});

describe('deleteObjectsUnderPrefix', () => {
  it('lists and deletes page by page until the listing ends', async () => {
    const objects = { main: ['p/a', 'p/b', 'p/c', 'q/d'] };
    const { storage, sent } = fakeS3(objects, 2);
    await expect(storage.deleteObjectsUnderPrefix('main', 'p/')).resolves.toBe(3);
    expect(objects.main).toEqual(['q/d']);
    expect(sent.filter((c) => c instanceof DeleteObjectsCommand)).toHaveLength(2);
  });

  it('throws when S3 reports a key it could not delete', async () => {
    const { storage, send } = fakeS3({ main: ['p/a'] });
    send.mockImplementationOnce(async () => ({ Contents: [{ Key: 'p/a' }], IsTruncated: false }));
    send.mockImplementationOnce(async () => ({ Errors: [{ Key: 'p/a', Code: 'AccessDenied' }] }));
    await expect(storage.deleteObjectsUnderPrefix('main', 'p/')).rejects.toThrow('AccessDenied');
  });

  it('refuses a prefix that is not a folder', async () => {
    const { storage } = fakeS3({});
    await expect(storage.deleteObjectsUnderPrefix('main', 'avatars/drv')).rejects.toThrow();
    await expect(storage.deleteObjectsUnderPrefix('main', '')).rejects.toThrow();
  });
});

describe('purgeDriverAvatarObjects', () => {
  it("deletes the driver's clean images and uploads in every bucket, and nobody else's", async () => {
    const objects = {
      main: [
        `avatars/${DRIVER}/a.jpg`,
        `avatars/${DRIVER}/b.png`,
        `ai-uploads/quarantine/avatars/${DRIVER}/u/avatar`,
        'avatars/drv_10/a.jpg',
        'avatars/drv_2/a.jpg',
      ],
      old: [`avatars/${DRIVER}/c.jpg`],
    };
    const { storage } = fakeS3(objects);
    await expect(purgeDriverAvatarObjects(storage, DRIVER, ['old', 'main'])).resolves.toBe(4);
    expect(objects).toEqual({ main: ['avatars/drv_10/a.jpg', 'avatars/drv_2/a.jpg'], old: [] });
  });
});

describe('runAvatarCleanupJob', () => {
  it('purges an erased or deleted driver', async () => {
    const objects = { main: [`avatars/${DRIVER}/a.jpg`] };
    const { storage } = fakeS3(objects);
    dbRows = [[{ erasedAt: new Date() }]];
    await runAvatarCleanupJob('purge-driver', { driverId: DRIVER, buckets: [] }, storage, log);
    expect(objects.main).toEqual([]);
    objects.main = [`avatars/${DRIVER}/b.jpg`];
    dbRows = [[]];
    await runAvatarCleanupJob('purge-driver', { driverId: DRIVER, buckets: [] }, storage, log);
    expect(objects.main).toEqual([]);
  });

  it('never purges a driver that is not erased', async () => {
    const objects = { main: [`avatars/${DRIVER}/a.jpg`] };
    const { storage } = fakeS3(objects);
    dbRows = [[{ erasedAt: null }]];
    await runAvatarCleanupJob('purge-driver', { driverId: DRIVER, buckets: [] }, storage, log);
    expect(objects.main).toHaveLength(1);
    expect(log.warn).toHaveBeenCalled();
  });

  it('deletes one object only while no driver row points at it', async () => {
    const key = `avatars/${DRIVER}/a.jpg`;
    const objects = { main: [key] };
    const { storage } = fakeS3(objects);
    dbRows = [[{ id: DRIVER }]];
    await runAvatarCleanupJob(
      'delete-object',
      { driverId: DRIVER, bucket: 'main', key },
      storage,
      log,
    );
    expect(objects.main).toEqual([key]);
    dbRows = [[]];
    await runAvatarCleanupJob(
      'delete-object',
      { driverId: DRIVER, bucket: 'main', key },
      storage,
      log,
    );
    expect(objects.main).toEqual([]);
  });

  it('throws without storage, so the queue retries', async () => {
    dbRows = [[]];
    await expect(
      runAvatarCleanupJob('purge-driver', { driverId: DRIVER, buckets: [] }, null, log),
    ).rejects.toThrow('not configured');
    dbRows = [[]];
    await expect(
      runAvatarCleanupJob('delete-object', { driverId: DRIVER, bucket: 'b', key: 'k' }, null, log),
    ).rejects.toThrow('not configured');
  });

  it('drops an unknown job name with a warning', async () => {
    await runAvatarCleanupJob('other', {}, null, log);
    expect(log.warn).toHaveBeenCalled();
  });

  it('purges a deleted user, never an active one or one with an avatar again', async () => {
    const objects = {
      main: [
        'avatars/users/usr_1/a.jpg',
        'ai-uploads/quarantine/avatars/users/usr_1/h/u/avatar',
        `avatars/${DRIVER}/a.jpg`,
      ],
    };
    const { storage } = fakeS3(objects);
    dbRows = [[{ isActive: true, avatarKind: null }]];
    await runAvatarCleanupJob('purge-user', { userId: 'usr_1', buckets: [] }, storage, log);
    expect(objects.main).toHaveLength(3);
    dbRows = [[{ isActive: false, avatarKind: 'generated' }]];
    await runAvatarCleanupJob('purge-user', { userId: 'usr_1', buckets: [] }, storage, log);
    expect(objects.main).toHaveLength(3);
    dbRows = [[{ isActive: false, avatarKind: null }]];
    await runAvatarCleanupJob('purge-user', { userId: 'usr_1', buckets: [] }, storage, log);
    expect(objects.main).toEqual([`avatars/${DRIVER}/a.jpg`]);
  });

  it('deletes one user object only while no user row points at it', async () => {
    const key = 'avatars/users/usr_1/a.jpg';
    const objects = { main: [key] };
    const { storage } = fakeS3(objects);
    dbRows = [[{ id: 'usr_1' }]];
    await runAvatarCleanupJob(
      'delete-user-object',
      { userId: 'usr_1', bucket: 'main', key },
      storage,
      log,
    );
    expect(objects.main).toEqual([key]);
    dbRows = [[]];
    await runAvatarCleanupJob(
      'delete-user-object',
      { userId: 'usr_1', bucket: 'main', key },
      storage,
      log,
    );
    expect(objects.main).toEqual([]);
  });
});

describe('purgeUserAvatarObjects', () => {
  it("deletes only the user's objects", async () => {
    const objects = {
      main: ['avatars/users/usr_1/a.jpg', 'avatars/users/usr_10/a.jpg', 'avatars/drv_1/a.jpg'],
    };
    const { storage } = fakeS3(objects);
    await expect(purgeUserAvatarObjects(storage, 'usr_1')).resolves.toBe(1);
    expect(objects.main).toEqual(['avatars/users/usr_10/a.jpg', 'avatars/drv_1/a.jpg']);
  });
});
