// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { vi } from 'vitest';
import type {
  PushJobName,
  PushJobSink,
  SessionCompletedHook,
} from '../../services/push.service.js';

/** What the inline sink saw: every job added, with its deduplication id. */
export interface InlinePushSink extends PushJobSink {
  jobs: Array<{ name: PushJobName; data: unknown; deduplicationId: string }>;
  scheduleCdr: ReturnType<typeof vi.fn<PushJobSink['scheduleCdr']>>;
  pushStoredCdr: ReturnType<typeof vi.fn<PushJobSink['pushStoredCdr']>>;
}

/**
 * A push sink that runs each job at once in this process, as the OCPI queue
 * worker would: a job that throws is swallowed (BullMQ retries it). Loads
 * push.service lazily, so a test's module mocks apply.
 */
export function inlinePushSink(
  onSessionCompleted: SessionCompletedHook | null = null,
): InlinePushSink {
  const sink: InlinePushSink = {
    jobs: [],
    scheduleCdr: vi.fn<PushJobSink['scheduleCdr']>(async () => undefined),
    pushStoredCdr: vi.fn<PushJobSink['pushStoredCdr']>(async () => undefined),
    add: async (name, data, deduplicationId) => {
      sink.jobs.push({ name, data, deduplicationId });
      const { processPushJob } = await import('../../services/push.service.js');
      await processPushJob(name, data, { sink, onSessionCompleted }).catch(() => undefined);
    },
  };
  return sink;
}
