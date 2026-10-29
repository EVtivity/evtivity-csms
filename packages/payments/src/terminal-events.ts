// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { createHash } from 'node:crypto';
import { jobQueue } from '@evtivity/lib/job-queues';
import {
  PAYMENT_TERMINAL_EVENTS_JOB_OPTIONS,
  PAYMENT_TERMINAL_EVENTS_QUEUE,
} from '@evtivity/lib/worker-queues';
import type { SimulatedTerminalEventSink } from '@evtivity/payment-terminals';

/** One job of the `payment-terminal-events` queue: a signed provider body, as the webhook route gets it. */
export interface TerminalEventJob {
  provider: 'simulated';
  rawBody: string;
  signature: string;
}

/**
 * The simulated terminal provider's event sink (features/payment-terminals.md):
 * the signed body goes to the worker's queue, added by the producer itself so
 * it survives a stopped worker (P8), delayed two seconds as a card tap would
 * be. The job id is the body hash (P7).
 */
export function queueTerminalEventSink(): SimulatedTerminalEventSink {
  return async (event) => {
    const job: TerminalEventJob = { provider: 'simulated', ...event };
    await jobQueue(PAYMENT_TERMINAL_EVENTS_QUEUE, PAYMENT_TERMINAL_EVENTS_JOB_OPTIONS).add(
      'terminal-event',
      job,
      {
        jobId: `sim-${createHash('sha256').update(event.rawBody).digest('hex').slice(0, 40)}`,
        delay: 2000,
      },
    );
  };
}
