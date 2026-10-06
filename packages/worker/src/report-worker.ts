// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { Worker, type ConnectionOptions, type Queue } from 'bullmq';
import { z } from 'zod';
import type { PubSubClient } from '@evtivity/lib';
import { createLogger } from '@evtivity/lib';
import {
  REPORT_GENERATE_CHANNEL,
  generateReport,
  reportJobId,
} from '@evtivity/services/report.service';
import { QUEUE_NAMES } from './queues.js';
import { logJobStarted, logJobCompleted, logJobFailed } from './job-logger.js';

const log = createLogger('report-worker');

const messageSchema = z.object({ reportId: z.string().min(1) });

interface ReportJobData {
  reportId: string;
}

let reportQueue: Queue | null = null;

/** The queue `enqueueReport` adds to; set once at worker startup. */
export function setReportQueue(queue: Queue): void {
  reportQueue = queue;
}

/** Queues the generation of a stored report; one job per report (P7). */
export async function enqueueReport(reportId: string): Promise<void> {
  if (reportQueue == null) throw new Error('Report queue is not set');
  const data: ReportJobData = { reportId };
  await reportQueue.add('report-generate', data, { jobId: reportJobId(reportId) });
}

/**
 * Subscribes to REPORT_GENERATE_CHANNEL (a report the API stored) and queues
 * its generation. Every worker replica receives each message, and BullMQ
 * keeps a single job under the report's job id.
 */
export async function startReportBridge(pubsub: PubSubClient): Promise<() => Promise<void>> {
  const subscription = await pubsub.subscribe(REPORT_GENERATE_CHANNEL, (payload: string) => {
    let message: ReportJobData;
    try {
      message = messageSchema.parse(JSON.parse(payload));
    } catch (err) {
      log.warn({ err }, 'Malformed report message dropped');
      return;
    }
    enqueueReport(message.reportId).catch((err: unknown) => {
      log.error({ err, reportId: message.reportId }, 'Failed to queue report generation');
    });
  });

  log.info('Report bridge started');

  return async () => {
    await subscription.unsubscribe();
    log.info('Report bridge stopped');
  };
}

/**
 * Generates reports (`generateReport`). A report generator can hold the event
 * loop for seconds, so reports run one at a time.
 */
export function createReportWorker(connection: ConnectionOptions): Worker {
  const worker = new Worker<ReportJobData>(
    QUEUE_NAMES.REPORTS,
    async (job) => {
      const logId = await logJobStarted(job.name, QUEUE_NAMES.REPORTS);
      const startTime = Date.now();
      try {
        await generateReport(job.data.reportId);
        await logJobCompleted(logId, Date.now() - startTime);
      } catch (err) {
        const errorMsg = err instanceof Error ? err.message : 'Unknown error';
        await logJobFailed(logId, Date.now() - startTime, errorMsg).catch((logErr: unknown) => {
          log.warn({ err: logErr, jobId: job.id }, 'Failed to record report job failure');
        });
        throw err;
      }
    },
    { connection, concurrency: 1 },
  );

  worker.on('failed', (job, err) => {
    if (job == null) return;
    log.error({ jobId: job.id, error: err }, 'Report job failed');
  });

  return worker;
}
