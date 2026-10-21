// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import type { FastifyInstance, FastifyRequest } from 'fastify';
import { hasAmbiguousPathEncoding } from '@evtivity/lib';

/**
 * The matched route pattern of a request (`/v1/stations/:id`), so a hook decides on
 * the route that runs; the raw path when no route matched (the request ends in a 404).
 */
export function routePath(request: FastifyRequest): string {
  return request.routeOptions.url ?? request.url.split('?')[0] ?? request.url;
}

/**
 * Refuses, before every other hook, a request whose path percent-encodes a
 * plain character or a slash (400 VALIDATION_ERROR): the router decodes them,
 * so CSRF, the email verification gate, feature switches, the access log and
 * the response cache would otherwise decide on another path than the route
 * that runs. Register it first.
 */
export function registerEncodedPathGuard(app: FastifyInstance): void {
  app.addHook('onRequest', async (request, reply) => {
    if (!hasAmbiguousPathEncoding(request.url)) return;
    await reply.status(400).send({
      error: 'The request path encodes characters that must be sent as they are',
      code: 'VALIDATION_ERROR',
    });
  });
}
