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
import { cpoLocationRoutes } from './routes/cpo/locations.js';
import { cpoSessionRoutes, cpoCdrRoutes } from './routes/cpo/sessions.js';
import { cpoTariffRoutes } from './routes/cpo/tariffs.js';
import { cpoTokenRoutes } from './routes/cpo/tokens.js';
import { emspLocationRoutes } from './routes/emsp/locations.js';
import { emspSessionRoutes } from './routes/emsp/sessions.js';
import { emspCdrRoutes } from './routes/emsp/cdrs.js';
import { emspTariffRoutes } from './routes/emsp/tariffs.js';
import { emspTokenRoutes } from './routes/emsp/tokens.js';
import { cpoCommandRoutes } from './routes/cpo/commands.js';
import { emspCommandRoutes } from './routes/emsp/commands.js';
import { hubClientInfoRoutes } from './routes/hubclientinfo.js';

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

  await app.register(versionRoutes);
  await app.register(credentialRoutes);
  await app.register(cpoLocationRoutes);
  await app.register(cpoSessionRoutes);
  await app.register(cpoCdrRoutes);
  await app.register(cpoTariffRoutes);
  await app.register(cpoTokenRoutes);
  await app.register(emspLocationRoutes);
  await app.register(emspSessionRoutes);
  await app.register(emspCdrRoutes);
  await app.register(emspTariffRoutes);
  await app.register(emspTokenRoutes);
  await app.register(cpoCommandRoutes);
  await app.register(emspCommandRoutes);
  await app.register(hubClientInfoRoutes);

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
