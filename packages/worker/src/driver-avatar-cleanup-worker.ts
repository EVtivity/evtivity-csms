// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { Worker, type ConnectionOptions } from 'bullmq';
import { createLogger } from '@evtivity/lib';
import { runAvatarCleanupJob } from '@evtivity/services/avatar-storage';
import { loadObjectStorage } from '@evtivity/services/storage';
import { config } from './lib/config.js';
import { QUEUE_NAMES } from './queues.js';

const log = createLogger('driver-avatar-cleanup-worker');

/**
 * Deletes the driver avatar objects a delete in the API (or the conformance
 * driver cleanup) could not remove: one image no row points at, or every
 * object of an erased or deleted driver (`runAvatarCleanupJob`). A
 * storage failure throws and the queue retries it with backoff.
 */
export function createDriverAvatarCleanupWorker(connection: ConnectionOptions): Worker {
  const worker = new Worker(
    QUEUE_NAMES.DRIVER_AVATAR_CLEANUP,
    async (job) => {
      const storage = await loadObjectStorage(config.SETTINGS_ENCRYPTION_KEY);
      await runAvatarCleanupJob(job.name, job.data, storage, log.child({ jobId: job.id }));
    },
    { connection, concurrency: 2 },
  );

  worker.on('failed', (job, err) => {
    if (job == null) return;
    log.error(
      { jobId: job.id, jobName: job.name, attempt: job.attemptsMade, error: err },
      'Driver avatar cleanup job failed',
    );
  });

  return worker;
}
