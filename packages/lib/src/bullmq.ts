// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { Redis } from 'ioredis';

/**
 * Creates an ioredis connection suitable for BullMQ.
 * BullMQ requires a dedicated connection (not the shared pubsub one).
 * maxRetriesPerRequest must be null for BullMQ blocking commands.
 */
export function createBullMQConnection(redisUrl?: string): Redis {
  const url = redisUrl ?? process.env['REDIS_URL'] ?? 'redis://localhost:6379';
  return new Redis(url, {
    maxRetriesPerRequest: null,
    enableReadyCheck: false,
  });
}
