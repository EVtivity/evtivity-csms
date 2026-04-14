// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { Worker, type Queue, type ConnectionOptions } from 'bullmq';
import type { PubSubClient } from '@evtivity/lib';
import { createLogger } from '@evtivity/lib';
import { QUEUE_NAMES } from './queues.js';
import { logJobStarted, logJobCompleted, logJobFailed } from './job-logger.js';
import { handleReservationActivate } from './handlers/reservation-activate.js';

const log = createLogger('reservation-worker');

/**
 * Subscribes to the reservation_schedule pub/sub channel and enqueues delayed
 * BullMQ jobs that fire at the reservation's startsAt time.
 */
export async function startReservationBridge(
  pubsub: PubSubClient,
  reservationQueue: Queue,
): Promise<() => Promise<void>> {
  const subscription = await pubsub.subscribe('reservation_schedule', (payload: string) => {
    let data: { reservationDbId: string; delayMs: number };
    try {
      data = JSON.parse(payload) as { reservationDbId: string; delayMs: number };
    } catch {
      return;
    }

    void reservationQueue
      .add(
        'reservation-activate',
        { reservationDbId: data.reservationDbId },
        {
          jobId: `reservation-activate-${data.reservationDbId}`,
          delay: data.delayMs,
          attempts: 3,
        },
      )
      .catch((err: unknown) => {
        log.error(
          { err, reservationDbId: data.reservationDbId },
          'Failed to enqueue reservation-activate job',
        );
      });
  });

  log.info('Reservation schedule bridge started');

  return async () => {
    await subscription.unsubscribe();
    log.info('Reservation schedule bridge stopped');
  };
}

/**
 * Creates the BullMQ Worker that processes delayed reservation activation jobs.
 */
export function createReservationWorker(
  connection: ConnectionOptions,
  pubsub: PubSubClient,
): Worker {
  const worker = new Worker(
    QUEUE_NAMES.RESERVATIONS,
    async (job) => {
      const logId = await logJobStarted(job.name, 'reservations');
      const startTime = Date.now();
      try {
        await handleReservationActivate(job, pubsub);
        await logJobCompleted(logId, Date.now() - startTime);
      } catch (err) {
        const errorMsg = err instanceof Error ? err.message : 'Unknown error';
        await logJobFailed(logId, Date.now() - startTime, errorMsg).catch(() => {});
        throw err;
      }
    },
    { connection, concurrency: 5 },
  );

  worker.on('failed', (job, err) => {
    if (job == null) return;
    log.error({ jobName: job.name, error: err }, 'Reservation job failed');
  });

  return worker;
}
