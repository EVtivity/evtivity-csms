// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { Worker, type ConnectionOptions } from 'bullmq';
import { client } from '@evtivity/database';
import { createLogger } from '@evtivity/lib';
import type { PubSubClient } from '@evtivity/lib';
import { REFUSED_START_STOP_JOB, runRefusedStartStop } from '@evtivity/services/refused-start-stop';
import type { PaymentStopTarget } from '@evtivity/services/refused-start-stop';
import { QUEUE_NAMES } from './queues.js';

const log = createLogger('payment-stop-worker');

/**
 * Runs the delayed payment stops the OCPP payment gate adds: the stop of a
 * start the CSMS refused for no fleet credit, after its grace period
 * (`runRefusedStartStop`). Job id per session (P7). A failed publish throws
 * and the queue retries it.
 */
export function createPaymentStopWorker(
  connection: ConnectionOptions,
  pubsub: PubSubClient,
): Worker {
  const worker = new Worker<PaymentStopTarget>(
    QUEUE_NAMES.PAYMENT_STOPS,
    async (job) => {
      if (job.name !== REFUSED_START_STOP_JOB) {
        log.warn({ jobId: job.id, jobName: job.name }, 'Unknown payment stop job dropped');
        return;
      }
      await runRefusedStartStop(
        { sql: client, pubsub, logger: log.child({ jobId: job.id }) },
        job.data,
      );
    },
    { connection, concurrency: 5 },
  );

  worker.on('failed', (job, err) => {
    if (job == null) return;
    log.error({ jobId: job.id, jobName: job.name, error: err }, 'Payment stop job failed');
  });

  return worker;
}
