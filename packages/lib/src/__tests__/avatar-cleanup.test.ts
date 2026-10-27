// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  DRIVER_AVATAR_DELETE_JOB,
  DRIVER_AVATAR_PURGE_JOB,
  driverAvatarDeleteJobId,
  driverAvatarObjectPrefixes,
  driverAvatarPurgeJobId,
  enqueueDriverAvatarObjectDelete,
  enqueueDriverAvatarPurge,
  enqueueUserAvatarObjectDelete,
  enqueueUserAvatarPurge,
  USER_AVATAR_DELETE_JOB,
  USER_AVATAR_PURGE_JOB,
  userAvatarObjectPrefixes,
  userAvatarPurgeJobId,
} from '../avatar-cleanup.js';
import { setJobQueueResolver } from '../job-queues.js';
import { DRIVER_AVATAR_CLEANUP_QUEUE } from '../worker-queues.js';

describe('driver avatar cleanup jobs', () => {
  afterEach(() => {
    setJobQueueResolver(null);
  });

  it('names both prefixes of a driver, each ending in a slash', () => {
    expect(driverAvatarObjectPrefixes('drv_1')).toEqual([
      'avatars/drv_1/',
      'ai-uploads/quarantine/avatars/drv_1/',
    ]);
  });

  it('derives deterministic job ids without a colon', () => {
    expect(driverAvatarPurgeJobId('drv_1')).toBe('driver-avatar-purge.drv_1');
    const id = driverAvatarDeleteJobId('b', 'avatars/drv_1/x.jpg');
    expect(id).toBe(driverAvatarDeleteJobId('b', 'avatars/drv_1/x.jpg'));
    expect(id).not.toBe(driverAvatarDeleteJobId('b', 'avatars/drv_1/y.jpg'));
    expect(id).toMatch(/^driver-avatar-object\.[0-9a-f]{32}$/);
  });

  it('adds the jobs to the cleanup queue with their job ids', async () => {
    const add = vi.fn().mockResolvedValue(undefined);
    const names: string[] = [];
    setJobQueueResolver((name) => {
      names.push(name);
      return { add, addBulk: vi.fn() };
    });
    await enqueueDriverAvatarPurge({ driverId: 'drv_1', buckets: ['old'] });
    await enqueueDriverAvatarObjectDelete({ driverId: 'drv_1', bucket: 'b', key: 'k' });
    expect(names).toEqual([DRIVER_AVATAR_CLEANUP_QUEUE, DRIVER_AVATAR_CLEANUP_QUEUE]);
    expect(add).toHaveBeenNthCalledWith(
      1,
      DRIVER_AVATAR_PURGE_JOB,
      { driverId: 'drv_1', buckets: ['old'] },
      { jobId: 'driver-avatar-purge.drv_1' },
    );
    expect(add).toHaveBeenNthCalledWith(
      2,
      DRIVER_AVATAR_DELETE_JOB,
      { driverId: 'drv_1', bucket: 'b', key: 'k' },
      { jobId: driverAvatarDeleteJobId('b', 'k') },
    );
  });

  it('throws when the queue refuses the job, so the caller can log it', async () => {
    setJobQueueResolver(() => ({
      add: vi.fn().mockRejectedValue(new Error('redis down')),
      addBulk: vi.fn(),
    }));
    await expect(enqueueDriverAvatarPurge({ driverId: 'drv_1', buckets: [] })).rejects.toThrow(
      'redis down',
    );
  });

  it('names the user prefixes under users/, apart from every driver prefix', () => {
    expect(userAvatarObjectPrefixes('usr_1')).toEqual([
      'avatars/users/usr_1/',
      'ai-uploads/quarantine/avatars/users/usr_1/',
    ]);
    expect(userAvatarPurgeJobId('usr_1')).toBe('user-avatar-purge.usr_1');
  });

  it('adds the user jobs to the same cleanup queue with their job ids', async () => {
    const add = vi.fn().mockResolvedValue(undefined);
    setJobQueueResolver(() => ({ add, addBulk: vi.fn() }));
    await enqueueUserAvatarPurge({ userId: 'usr_1', buckets: [] });
    await enqueueUserAvatarObjectDelete({ userId: 'usr_1', bucket: 'b', key: 'k2' });
    expect(add).toHaveBeenNthCalledWith(
      1,
      USER_AVATAR_PURGE_JOB,
      { userId: 'usr_1', buckets: [] },
      { jobId: 'user-avatar-purge.usr_1' },
    );
    expect(add).toHaveBeenNthCalledWith(
      2,
      USER_AVATAR_DELETE_JOB,
      { userId: 'usr_1', bucket: 'b', key: 'k2' },
      { jobId: driverAvatarDeleteJobId('b', 'k2') },
    );
  });
});
