// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { Worker, type ConnectionOptions } from 'bullmq';
import { createLogger } from '@evtivity/lib';
import {
  runTerminalEventJob,
  type TerminalEventJob,
} from '@evtivity/services/payment-terminal-flow';
import { terminalFlowDeps } from './lib/payments.js';
import { QUEUE_NAMES } from './queues.js';

const log = createLogger('payment-terminal-events-worker');

/**
 * Applies signed payment terminal events from the queue (the simulated
 * provider's async device; features/payment-terminals.md) exactly as the
 * webhook route applies a provider's: signature check, dedupe on the event id
 * under its lock, then the follow-up (an authorization starts charging). A
 * failure throws and the queue retries it; the dedupe makes that safe.
 */
export function createPaymentTerminalEventsWorker(connection: ConnectionOptions): Worker {
  const worker = new Worker(
    QUEUE_NAMES.PAYMENT_TERMINAL_EVENTS,
    async (job) => {
      await runTerminalEventJob(
        job.data as TerminalEventJob,
        terminalFlowDeps(log.child({ jobId: job.id })),
      );
    },
    { connection, concurrency: 4 },
  );
  worker.on('failed', (job, err) => {
    if (job == null) return;
    log.error(
      { jobId: job.id, attempt: job.attemptsMade, error: err },
      'Payment terminal event job failed',
    );
  });
  return worker;
}
