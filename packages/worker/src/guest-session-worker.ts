// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { Worker, type Queue, type ConnectionOptions } from 'bullmq';
import type { PubSubClient } from '@evtivity/lib';
import { createLogger } from '@evtivity/lib';
import { failExhaustedGuestCapture, handleGuestSessionEvent } from '@evtivity/payments';
import { QUEUE_NAMES } from './queues.js';
import { logJobStarted, logJobCompleted, logJobFailed } from './job-logger.js';
import { guestEventDeps, paymentContext } from './lib/payments.js';

const log = createLogger('guest-session-worker');

export interface CsmsEvent {
  type: string;
  sessionId?: string;
  idToken?: { idToken: string; type: string };
  [key: string]: unknown;
}

/** Adds the job that links a guest session to its started transaction (bridge and Redis recovery). */
export async function enqueueGuestSessionStarted(
  guestSessionQueue: Queue,
  event: CsmsEvent & { idToken: { idToken: string; type: string } },
): Promise<void> {
  await guestSessionQueue.add(
    'guest-session-started',
    { event },
    { jobId: `guest-session-started-${event.idToken.idToken}`, attempts: 3 },
  );
}

/** Adds the job that captures or cancels a guest hold when its transaction ended (bridge and Redis recovery). */
export async function enqueueGuestSessionEnded(
  guestSessionQueue: Queue,
  sessionId: string,
): Promise<void> {
  await guestSessionQueue.add(
    'guest-session-ended',
    { sessionId },
    { jobId: `guest-session-ended-${sessionId}`, attempts: 3 },
  );
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
      enqueueGuestSessionStarted(guestSessionQueue, {
        ...event,
        idToken: event.idToken,
      }).catch((err: unknown) => {
        log.error({ err }, 'Failed to enqueue guest-session-started job');
      });
    }

    if (event.type === 'TransactionEnded' && event.sessionId != null) {
      enqueueGuestSessionEnded(guestSessionQueue, event.sessionId).catch((err: unknown) => {
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
          await handleGuestSessionEvent(data.event as CsmsEvent, guestEventDeps(log));
        } else if (job.name === 'guest-session-ended') {
          await handleGuestSessionEvent(
            { type: 'TransactionEnded', sessionId: data.sessionId as string },
            guestEventDeps(log),
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
    log.error(
      { jobName: job.name, attemptsMade: job.attemptsMade, error: err },
      'Guest session job failed',
    );

    // After the final retry: the guest session fails, its open hold is
    // recorded failed and cancelled at once (P4), so the portal leaves its
    // waiting loop and the cardholder's hold is released instead of waiting
    // for the provider's expiry (Stripe: 7 days).
    const maxAttempts = job.opts.attempts ?? 1;
    if (job.attemptsMade < maxAttempts) return;
    if (job.name !== 'guest-session-ended') return;

    const data = job.data as Record<string, unknown>;
    const sessionId = data.sessionId as string | undefined;
    if (sessionId == null) return;

    const failureReason = err instanceof Error ? err.message.slice(0, 500) : 'Unknown error';
    failExhaustedGuestCapture(sessionId, failureReason, paymentContext(log)).catch(
      (cleanupErr: unknown) => {
        log.error(
          { sessionId, err: cleanupErr },
          'Failed to clean up after exhausted guest capture retries',
        );
      },
    );
  });

  return worker;
}
