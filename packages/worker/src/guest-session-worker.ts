// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { Worker, type Queue, type ConnectionOptions } from 'bullmq';
import type { PubSubClient } from '@evtivity/lib';
import { createLogger } from '@evtivity/lib';
import { QUEUE_NAMES } from './queues.js';
import { logJobStarted, logJobCompleted, logJobFailed } from './job-logger.js';
import { handleGuestSessionEvent } from '@evtivity/api/src/services/guest-session.service.js';

const log = createLogger('guest-session-worker');

interface CsmsEvent {
  type: string;
  sessionId?: string;
  idToken?: { idToken: string; type: string };
  [key: string]: unknown;
}

/**
 * Subscribes to csms_events pub/sub and enqueues guest session jobs.
 * Using jobId deduplication means if multiple worker replicas receive
 * the same pub/sub event, only one BullMQ job is created per session.
 */
export async function startGuestSessionBridge(
  pubsub: PubSubClient,
  guestSessionQueue: Queue,
): Promise<() => Promise<void>> {
  const subscription = await pubsub.subscribe('csms_events', (payload: string) => {
    let event: CsmsEvent;
    try {
      event = JSON.parse(payload) as CsmsEvent;
    } catch {
      return;
    }

    if (event.type === 'TransactionStarted' && event.idToken?.idToken != null) {
      void guestSessionQueue
        .add(
          'guest-session-started',
          { event },
          { jobId: `guest-session-started-${event.idToken.idToken}`, attempts: 3 },
        )
        .catch((err: unknown) => {
          log.error({ err }, 'Failed to enqueue guest-session-started job');
        });
    }

    if (event.type === 'TransactionEnded' && event.sessionId != null) {
      void guestSessionQueue
        .add(
          'guest-session-ended',
          { sessionId: event.sessionId },
          { jobId: `guest-session-ended-${event.sessionId}`, attempts: 3 },
        )
        .catch((err: unknown) => {
          log.error({ err }, 'Failed to enqueue guest-session-ended job');
        });
    }
  });

  log.info('Guest session bridge started');

  return async () => {
    await subscription.unsubscribe();
    log.info('Guest session bridge stopped');
  };
}

/**
 * Creates the BullMQ Worker that processes guest session jobs.
 */
export function createGuestSessionWorker(connection: ConnectionOptions): Worker {
  const worker = new Worker(
    QUEUE_NAMES.GUEST_SESSION_EVENTS,
    async (job) => {
      const logId = await logJobStarted(job.name, 'guest-session-events');
      const startTime = Date.now();
      try {
        const data = job.data as Record<string, unknown>;
        if (job.name === 'guest-session-started') {
          await handleGuestSessionEvent(data.event as CsmsEvent, log as never);
        } else if (job.name === 'guest-session-ended') {
          await handleGuestSessionEvent(
            { type: 'TransactionEnded', sessionId: data.sessionId as string },
            log as never,
          );
        }
        await logJobCompleted(logId, Date.now() - startTime);
      } catch (err) {
        const errorMsg = err instanceof Error ? err.message : 'Unknown error';
        await logJobFailed(logId, Date.now() - startTime, errorMsg).catch(() => {});
        throw err;
      }
    },
    { connection, concurrency: 10 },
  );

  worker.on('failed', (job, err) => {
    if (job == null) return;
    log.error({ jobName: job.name, error: err }, 'Guest session job failed');
  });

  return worker;
}
