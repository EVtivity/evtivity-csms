// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { Worker, type ConnectionOptions, type Queue } from 'bullmq';
import { z } from 'zod';
import type { PubSubClient } from '@evtivity/lib';
import { createLogger } from '@evtivity/lib';
import { REMOTE_START_TIMEOUT_CHANNEL } from '@evtivity/database';
import type { RemoteStartTimeoutMessage, RemoteStartTimeoutTarget } from '@evtivity/database';
import { QUEUE_NAMES } from './queues.js';
import { logJobStarted, logJobCompleted, logJobFailed } from './job-logger.js';
import { handleRemoteStartTimeout } from './handlers/remote-start-timeout.js';

const log = createLogger('remote-start-timeout-worker');

const delayMs = z.number().int().nonnegative();
const messageSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('session'), sessionId: z.string().min(1), delayMs }),
  z.object({ kind: z.literal('guest'), guestSessionId: z.number().int().positive(), delayMs }),
]);

/**
 * One job per start (P7): every worker replica receives each pub/sub
 * message, and BullMQ keeps a single job under this id.
 */
export function remoteStartTimeoutJobId(target: RemoteStartTimeoutTarget): string {
  return target.kind === 'session'
    ? `remote-start-timeout-session-${target.sessionId}`
    : `remote-start-timeout-guest-${String(target.guestSessionId)}`;
}

/** Adds the delayed timeout job of an accepted start (bridge and Redis recovery). */
export async function enqueueRemoteStartTimeout(
  queue: Queue,
  target: RemoteStartTimeoutTarget,
  delayMs: number,
): Promise<void> {
  await queue.add('remote-start-timeout', target, {
    jobId: remoteStartTimeoutJobId(target),
    delay: delayMs,
  });
}

/**
 * Subscribes to REMOTE_START_TIMEOUT_CHANNEL (an accepted portal or guest
 * start, published by the API) and enqueues a delayed timeout job.
 */
export async function startRemoteStartTimeoutBridge(
  pubsub: PubSubClient,
  queue: Queue,
): Promise<() => Promise<void>> {
  const subscription = await pubsub.subscribe(REMOTE_START_TIMEOUT_CHANNEL, (payload: string) => {
    let message: RemoteStartTimeoutMessage;
    try {
      message = messageSchema.parse(JSON.parse(payload));
    } catch (err) {
      log.warn({ err }, 'Malformed remote start timeout message dropped');
      return;
    }
    const { delayMs: delay, ...target } = message;
    enqueueRemoteStartTimeout(queue, target, delay).catch((err: unknown) => {
      log.error({ err, target }, 'Failed to enqueue remote start timeout job');
    });
  });

  log.info('Remote start timeout bridge started');

  return async () => {
    await subscription.unsubscribe();
    log.info('Remote start timeout bridge stopped');
  };
}

/** Runs the timeout jobs (`handleRemoteStartTimeout`); errors are retried by the queue. */
export function createRemoteStartTimeoutWorker(
  connection: ConnectionOptions,
  pubsub: PubSubClient | null,
): Worker {
  const worker = new Worker<RemoteStartTimeoutTarget>(
    QUEUE_NAMES.REMOTE_START_TIMEOUTS,
    async (job) => {
      const logId = await logJobStarted(job.name, QUEUE_NAMES.REMOTE_START_TIMEOUTS);
      const startTime = Date.now();
      try {
        await handleRemoteStartTimeout(job.data, log.child({ jobId: job.id }), pubsub);
        await logJobCompleted(logId, Date.now() - startTime);
      } catch (err) {
        const errorMsg = err instanceof Error ? err.message : 'Unknown error';
        await logJobFailed(logId, Date.now() - startTime, errorMsg).catch((logErr: unknown) => {
          log.warn({ err: logErr, jobId: job.id }, 'Failed to record remote start timeout failure');
        });
        throw err;
      }
    },
    { connection, concurrency: 5 },
  );

  worker.on('failed', (job, err) => {
    if (job == null) return;
    log.error({ jobId: job.id, error: err }, 'Remote start timeout job failed');
  });

  return worker;
}
