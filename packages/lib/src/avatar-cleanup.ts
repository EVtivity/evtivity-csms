// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

// The jobs of the avatar cleanup queue (drivers and CSMS users), added by every process that
// can leave avatar objects in storage (the API on a failed delete, the
// conformance driver cleanup). The worker runs them
// (`@evtivity/services/avatar-storage`).

import { createHash } from 'node:crypto';
import { jobQueue } from './job-queues.js';
import { DRIVER_AVATAR_CLEANUP_JOB_OPTIONS, DRIVER_AVATAR_CLEANUP_QUEUE } from './worker-queues.js';

/** Job name: delete every object of an erased or deleted driver. */
export const DRIVER_AVATAR_PURGE_JOB = 'purge-driver';

/** Job name: delete one image a replace or removal left. */
export const DRIVER_AVATAR_DELETE_JOB = 'delete-object';

export interface DriverAvatarPurgeJob {
  driverId: string;
  /** Buckets to purge besides the configured one (a bucket the row named). */
  buckets: string[];
}

export interface DriverAvatarDeleteJob {
  driverId: string;
  bucket: string;
  key: string;
}

/** Clean images of one driver. */
export function driverAvatarCleanPrefix(driverId: string): string {
  return `avatars/${driverId}/`;
}

/** Quarantined uploads of one driver (the 1-day lifecycle rule also removes them). */
export function driverAvatarQuarantinePrefix(driverId: string): string {
  return `ai-uploads/quarantine/avatars/${driverId}/`;
}

/** Every prefix that holds objects of one driver's avatar. */
export function driverAvatarObjectPrefixes(driverId: string): string[] {
  return [driverAvatarCleanPrefix(driverId), driverAvatarQuarantinePrefix(driverId)];
}

/** One purge job per driver (P7). */
export function driverAvatarPurgeJobId(driverId: string): string {
  return `driver-avatar-purge.${driverId}`;
}

/** One delete job per object (P7). */
export function driverAvatarDeleteJobId(bucket: string, key: string): string {
  const digest = createHash('sha256').update(`${bucket}/${key}`).digest('hex').slice(0, 32);
  return `driver-avatar-object.${digest}`;
}

function cleanupQueue() {
  return jobQueue(DRIVER_AVATAR_CLEANUP_QUEUE, DRIVER_AVATAR_CLEANUP_JOB_OPTIONS);
}

/** Queues the purge of every object of an erased or deleted driver. Throws when Redis refuses it. */
export async function enqueueDriverAvatarPurge(job: DriverAvatarPurgeJob): Promise<void> {
  await cleanupQueue().add(DRIVER_AVATAR_PURGE_JOB, job, {
    jobId: driverAvatarPurgeJobId(job.driverId),
  });
}

/** Queues the delete of one image no row points at. Throws when Redis refuses it. */
export async function enqueueDriverAvatarObjectDelete(job: DriverAvatarDeleteJob): Promise<void> {
  await cleanupQueue().add(DRIVER_AVATAR_DELETE_JOB, job, {
    jobId: driverAvatarDeleteJobId(job.bucket, job.key),
  });
}

// Operator (CSMS user) avatars use the same queue with their own job names
// and prefixes under `users/`. A driver id starts with `drv_`, so no driver
// prefix holds a user object and the reverse.

/** Job name: delete every object of a deleted (deactivated) user. */
export const USER_AVATAR_PURGE_JOB = 'purge-user';

/** Job name: delete one user image a replace or removal left. */
export const USER_AVATAR_DELETE_JOB = 'delete-user-object';

export interface UserAvatarPurgeJob {
  userId: string;
  /** Buckets to purge besides the configured one (a bucket the row named). */
  buckets: string[];
}

export interface UserAvatarDeleteJob {
  userId: string;
  bucket: string;
  key: string;
}

/** Clean images of one user. */
export function userAvatarCleanPrefix(userId: string): string {
  return `avatars/users/${userId}/`;
}

/** Quarantined uploads of one user (the 1-day lifecycle rule also removes them). */
export function userAvatarQuarantinePrefix(userId: string): string {
  return `ai-uploads/quarantine/avatars/users/${userId}/`;
}

/** Every prefix that holds objects of one user's avatar. */
export function userAvatarObjectPrefixes(userId: string): string[] {
  return [userAvatarCleanPrefix(userId), userAvatarQuarantinePrefix(userId)];
}

/** One purge job per user (P7). */
export function userAvatarPurgeJobId(userId: string): string {
  return `user-avatar-purge.${userId}`;
}

/** Queues the purge of every object of a deleted user. Throws when Redis refuses it. */
export async function enqueueUserAvatarPurge(job: UserAvatarPurgeJob): Promise<void> {
  await cleanupQueue().add(USER_AVATAR_PURGE_JOB, job, {
    jobId: userAvatarPurgeJobId(job.userId),
  });
}

/** Queues the delete of one user image no row points at. Throws when Redis refuses it. */
export async function enqueueUserAvatarObjectDelete(job: UserAvatarDeleteJob): Promise<void> {
  await cleanupQueue().add(USER_AVATAR_DELETE_JOB, job, {
    jobId: driverAvatarDeleteJobId(job.bucket, job.key),
  });
}
