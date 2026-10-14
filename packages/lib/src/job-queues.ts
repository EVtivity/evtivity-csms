// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

// Adds BullMQ jobs to the worker's queues from any process. A request handed
// to the worker over pub/sub is lost when no worker subscribes at that moment
// (a stopped or restarting worker); a job added to its queue waits in Redis
// until a worker runs it. Each process's Redis user may write only the queues
// it adds to (`~bull:<queue>:*` in docker/redis/acl-rules.conf).

import { Queue, type JobsOptions } from 'bullmq';
import type { Redis } from 'ioredis';
import { logBullMQErrors } from './bullmq.js';
import { createRedisClient } from './redis-client.js';

export type { JobsOptions } from 'bullmq';

/** What a producer needs of a BullMQ Queue (tests pass a fake). */
export interface JobQueue {
  add(name: string, data: unknown, opts?: JobsOptions): Promise<unknown>;
  addBulk(jobs: Array<{ name: string; data: unknown; opts?: JobsOptions }>): Promise<unknown>;
}

/** Returns the queue of a name: the worker passes its own queues, tests a fake. */
export type JobQueueResolver = (name: string) => JobQueue | undefined;

let redisUrl: string | null = null;
let redis: Redis | null = null;
const queues = new Map<string, Queue>();
let resolver: JobQueueResolver | null = null;

/**
 * Lets this process add jobs (API and OCPP startup). The queues are created
 * on first use and share one connection that fails a command after two
 * retries, so a Redis outage fails the add instead of holding the caller.
 */
export function initJobQueues(url: string): void {
  redisUrl = url;
}

/**
 * Resolves queues through `next` instead (the worker passes the queues it
 * already holds; tests pass fakes). Null restores the default.
 */
export function setJobQueueResolver(next: JobQueueResolver | null): void {
  resolver = next;
}

/**
 * The queue `name`, created with `defaultJobOptions` on first use. BullMQ
 * applies the options of the Queue instance that adds a job, so every
 * producer of a queue passes the same options as the worker's queue.
 */
export function jobQueue(name: string, defaultJobOptions: JobsOptions): JobQueue {
  if (resolver != null) {
    const resolved = resolver(name);
    if (resolved == null) throw new Error(`Job queue ${name} is not available in this process`);
    return resolved;
  }
  const existing = queues.get(name);
  if (existing != null) return existing;
  if (redisUrl == null) throw new Error('Job queues are not initialized in this process');
  redis ??= createRedisClient(redisUrl, 'job-queues', { maxRetriesPerRequest: 2 });
  const queue = logBullMQErrors(new Queue(name, { connection: redis, defaultJobOptions }), name);
  queues.set(name, queue);
  return queue;
}

/** Closes the queues and their connection (process shutdown). */
export async function closeJobQueues(): Promise<void> {
  const open = [...queues.values()];
  const connection = redis;
  queues.clear();
  redis = null;
  for (const queue of open) await queue.close();
  if (connection != null) await connection.quit();
}
