// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import Fastify from 'fastify';
import type { FastifyInstance, FastifyServerOptions } from 'fastify';
import cors from '@fastify/cors';
import helmet from '@fastify/helmet';
import rateLimit from '@fastify/rate-limit';
import { AppError } from '@evtivity/lib';
import { isRoamingEnabled } from '@evtivity/database';
import { ocpiResponse, OcpiStatusCode } from './lib/ocpi-response.js';
import { versionRoutes } from './routes/versions.js';
import { credentialRoutes } from './routes/credentials.js';
import { OCPI_MODULES } from './modules.js';

export async function buildOcpiApp(opts: FastifyServerOptions = {}): Promise<FastifyInstance> {
  const app = Fastify(opts);

  await app.register(cors, { origin: true });
  await app.register(helmet, { contentSecurityPolicy: false });
  await app.register(rateLimit, {
    max: 300,
    timeWindow: 60_000,
    keyGenerator: (request) => {
      // Rate limit per partner (authenticated) or per IP (unauthenticated)
      const partner = (request as { ocpiPartner?: { partnerId?: string } }).ocpiPartner;
      return partner?.partnerId ?? request.ip;
    },
  });

  app.setErrorHandler((error: unknown, _request, reply) => {
    if (error instanceof AppError) {
      const statusCode =
        error.statusCode >= 400 && error.statusCode < 500
          ? OcpiStatusCode.CLIENT_ERROR
          : OcpiStatusCode.SERVER_ERROR;
      void reply.status(error.statusCode).send(ocpiResponse(null, statusCode, error.message));
      return;
    }
    const fastifyError = error as { statusCode?: number; message?: string };
    if (fastifyError.statusCode != null && fastifyError.statusCode < 500) {
      void reply
        .status(fastifyError.statusCode)
        .send(
          ocpiResponse(null, OcpiStatusCode.CLIENT_ERROR, fastifyError.message ?? 'Bad request'),
        );
      return;
    }
    app.log.error(error);
    void reply
      .status(500)
      .send(ocpiResponse(null, OcpiStatusCode.SERVER_ERROR, 'Internal server error'));
  });

  // Liveness for the load balancer; outside /ocpi/ so the roaming toggle does not gate it.
  app.get('/health', { config: { rateLimit: false } }, () => ({ status: 'ok' }));

  await app.register(versionRoutes);
  await app.register(credentialRoutes);
  for (const module of OCPI_MODULES) {
    for (const routes of module.routes) {
      await app.register(routes);
    }
  }

  // Block all OCPI endpoints when roaming is disabled
  app.addHook('onRequest', async (request, reply) => {
    const url = request.url.split('?')[0] ?? request.url;
    if (!url.startsWith('/ocpi/')) return;
    const enabled = await isRoamingEnabled();
    if (!enabled) {
      await reply
        .status(503)
        .send(ocpiResponse(null, OcpiStatusCode.SERVER_ERROR, 'Roaming is disabled'));
    }
  });

  return app;
}
