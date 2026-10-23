// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import type { FastifyRequest } from 'fastify';
import { driverTokenRejection } from '../plugins/auth.js';

/**
 * The driver id of a public route's caller, or null. Public portal routes
 * (no `authenticateDriver`) answer anyone, but may tailor a field to the
 * signed-in driver, such as `reservedByMe`. Only a token `authenticateDriver`
 * would accept counts (`driverTokenRejection`: a driver token, not MFA-pending or
 * enrollment, of an active driver, of the current session version); any other token is an anonymous caller.
 */
export async function optionalDriverId(request: FastifyRequest): Promise<string | null> {
  let payload: Record<string, unknown>;
  try {
    payload = await request.jwtVerify<Record<string, unknown>>();
  } catch {
    // fail-open: a missing or expired token makes the caller anonymous, which a public route serves
    return null;
  }
  if ((await driverTokenRejection(payload)) != null) return null;
  const driverId = payload['driverId'];
  return typeof driverId === 'string' ? driverId : null;
}
