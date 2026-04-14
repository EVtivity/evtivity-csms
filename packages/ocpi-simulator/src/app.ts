// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import Fastify from 'fastify';
import type { FastifyInstance } from 'fastify';
import { ocpiRoutes } from './routes/ocpi.js';
import { controlRoutes } from './routes/control.js';

export function buildSimApp(): FastifyInstance {
  const app = Fastify({
    logger: {
      level: process.env['LOG_LEVEL'] ?? 'info',
      ...(process.env['NODE_ENV'] !== 'production' ? { transport: { target: 'pino-pretty' } } : {}),
    },
  });

  app.register(ocpiRoutes);
  app.register(controlRoutes);

  return app;
}
