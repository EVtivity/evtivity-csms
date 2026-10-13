// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { Queue } from 'bullmq';
import type { Redis } from 'ioredis';
import { createRedisClient, logBullMQErrors } from '@evtivity/lib';
import {
  ACCOUNT_INVOICE_JOB_OPTIONS,
  MEMBER_INVOICE_QUEUE,
} from '@evtivity/services/account-invoice-jobs';
import type { MemberInvoiceJobQueue } from '@evtivity/services/fleet-invoice-run';
import { config } from './config.js';

// The API adds the "Invoice All Members" jobs to the worker's member-invoices
// BullMQ queue itself (the api Redis user may write `bull:member-invoices:*`
// only), so a request is kept in Redis while no worker runs. A pub/sub
// message would be lost without a subscriber.

let redis: Redis | null = null;
let queue: Queue | null = null;
let override: MemberInvoiceJobQueue | null = null;

/**
 * The member invoice queue, created on the first "Invoice All Members"
 * request (one per process) with the worker's job options. The connection
 * fails a command after two retries, so a Redis outage answers the request
 * with an error instead of holding it.
 */
export function memberInvoiceQueue(): MemberInvoiceJobQueue {
  if (override != null) return override;
  if (queue == null) {
    redis = createRedisClient(config.REDIS_URL, 'member-invoice-queue', {
      maxRetriesPerRequest: 2,
    });
    queue = logBullMQErrors(
      new Queue(MEMBER_INVOICE_QUEUE, {
        connection: redis,
        defaultJobOptions: ACCOUNT_INVOICE_JOB_OPTIONS,
      }),
      MEMBER_INVOICE_QUEUE,
    );
  }
  return queue;
}

/** Tests replace the queue; null restores the Redis queue. */
export function setMemberInvoiceQueue(next: MemberInvoiceJobQueue | null): void {
  override = next;
}

/** Closes the queue and its connection (API shutdown). */
export async function closeMemberInvoiceQueue(): Promise<void> {
  const open = queue;
  const connection = redis;
  queue = null;
  redis = null;
  if (open != null) await open.close();
  if (connection != null) await connection.quit();
}
