// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import type { EventEmitter } from 'node:events';
import type { Redis } from 'ioredis';
import { createLogger } from './logger.js';
import { createRedisClient } from './redis-client.js';

const logger = createLogger('bullmq');

// Connection failures the ioredis client's own listener (logRedisErrors)
// already logs at warn; BullMQ re-emits them on every Queue and Worker.
const CONNECTION_ERROR_CODES = new Set([
  'ECONNREFUSED',
  'ECONNRESET',
  'ENOTFOUND',
  'EAI_AGAIN',
  'ETIMEDOUT',
  'EPIPE',
]);

/**
 * Creates an ioredis connection suitable for BullMQ.
 * BullMQ requires a dedicated connection (not the shared pubsub one).
 * maxRetriesPerRequest must be null for BullMQ blocking commands.
 */
export function createBullMQConnection(redisUrl?: string): Redis {
  const url = redisUrl ?? process.env['REDIS_URL'] ?? 'redis://localhost:6379';
  return createRedisClient(url, 'bullmq', {
    maxRetriesPerRequest: null,
    enableReadyCheck: false,
  });
}

/**
 * Adds an 'error' listener to a BullMQ Queue or Worker. Without one, BullMQ
 * prints every re-emitted Redis connection error as a raw stack trace outside
 * the structured log (hundreds per second while Redis restarts). Connection
 * errors log at debug (the connection already logged them at warn); any other
 * error logs at warn with the queue name (P9, fail-open: BullMQ reconnects).
 */
export function logBullMQErrors<T extends EventEmitter>(target: T, queue: string): T {
  target.on('error', (err: Error) => {
    const code = (err as NodeJS.ErrnoException).code;
    if (code != null && CONNECTION_ERROR_CODES.has(code)) {
      logger.debug({ err: err.message, queue }, 'BullMQ connection error');
      return;
    }
    logger.warn({ err: err.message, queue }, 'BullMQ error');
  });
  return target;
}
