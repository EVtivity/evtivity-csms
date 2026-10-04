// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import type { Redis } from 'ioredis';
import { createLogger } from './logger.js';

const logger = createLogger('redis');

/**
 * Logs an ioredis client's connection errors at warn. Without an `error`
 * listener ioredis prints "[ioredis] Unhandled error event" and a stack trace
 * to stderr for every failed connection attempt, outside the structured log.
 * ioredis reconnects on its own; commands fail per the client's retry options,
 * so the error is logged and not rethrown (P9, fail-open at the edge).
 */
export function logRedisErrors(client: Redis, name: string): Redis {
  client.on('error', (err: Error) => {
    logger.warn({ err: err.message, client: name }, 'Redis connection error');
  });
  return client;
}
