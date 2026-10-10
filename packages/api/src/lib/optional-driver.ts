// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import type { FastifyRequest } from 'fastify';

/**
 * The driver id of a public route's caller, or null. Public portal routes
 * (no `authenticateDriver`) answer anyone, but may tailor a field to the
 * signed-in driver, such as `reservedByMe`. Only a verified driver token that
 * is not MFA-pending counts; an operator token, a missing or an invalid token
 * is an anonymous caller.
 */
export async function optionalDriverId(request: FastifyRequest): Promise<string | null> {
  let payload: Record<string, unknown>;
  try {
    payload = await request.jwtVerify<Record<string, unknown>>();
  } catch {
    // fail-open: a missing or expired token makes the caller anonymous, which a public route serves
    return null;
  }
  if (payload['type'] !== 'driver' || payload['mfaPending'] === true) return null;
  const driverId = payload['driverId'];
  return typeof driverId === 'string' ? driverId : null;
}
