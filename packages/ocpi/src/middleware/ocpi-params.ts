// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import type { FastifyReply, FastifyRequest } from 'fastify';
import { ocpiError, OcpiStatusCode } from '../lib/ocpi-response.js';
import { overlongParam } from '../lib/ocpi-fields.js';

/**
 * preHandler for module routes with ids in the URL: an empty id or one longer
 * than its OCPI field (country_code 2, party_id 3, ids 36) answers 400 with
 * status 2001 before any query, instead of failing the insert with a 500.
 */
export async function ocpiParamLimits(request: FastifyRequest, reply: FastifyReply): Promise<void> {
  const param = overlongParam(request.params);
  if (param == null) return;
  await reply.status(400).send(ocpiError(OcpiStatusCode.CLIENT_INVALID_PARAMS, `Invalid ${param}`));
}
