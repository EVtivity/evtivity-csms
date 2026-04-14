// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { db } from '@evtivity/database';
import { sql } from 'drizzle-orm';
import { zodSchema } from '../lib/zod-schema.js';
import { getPubSub } from '../lib/pubsub.js';

const healthResponse = z
  .object({
    status: z.string(),
    timestamp: z.string(),
    database: z.string(),
    redis: z.string(),
  })
  .passthrough();

export function healthRoutes(app: FastifyInstance): void {
  app.get(
    '/health',
    {
      schema: {
        tags: ['Health'],
        summary: 'Check API, database, and Redis health',
        operationId: 'getHealth',
        security: [],
        response: { 200: zodSchema(healthResponse) },
      },
    },
    async () => {
      let dbStatus = 'ok';
      try {
        await db.execute(sql`SELECT 1`);
      } catch {
        dbStatus = 'error';
      }

      let redisStatus = 'ok';
      try {
        const pubsub = getPubSub();
        if ('ping' in pubsub && typeof pubsub.ping === 'function') {
          const ok = await (pubsub.ping as () => Promise<boolean>)();
          if (!ok) redisStatus = 'error';
        }
      } catch {
        redisStatus = 'error';
      }

      const status = dbStatus === 'ok' && redisStatus === 'ok' ? 'ok' : 'degraded';
      return {
        status,
        timestamp: new Date().toISOString(),
        database: dbStatus,
        redis: redisStatus,
      };
    },
  );
}
